import { Pool, type PoolClient } from 'pg';
import { config } from '../config';
import { errorFields, logger } from '../logger';

// NUMERIC columns come back from pg as strings. We keep them that way so
// money values never pass through JavaScript floating point.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

pool.on('error', (err) => {
  // An idle client lost its connection. The pool discards it; log and move on.
  logger.error('idle Postgres client lost its connection', errorFields(err));
});

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Runs fn inside a single database transaction on one dedicated client.
 * Commits if fn resolves, rolls back if it throws, and always returns the
 * client to the pool.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: { isolation?: 'read committed' | 'repeatable read' | 'serializable'; readOnly?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  // If the connection drops while checked out, pg emits 'error' on the client.
  // With no listener, Node treats that as fatal and the whole server crashes.
  const onConnectionError = (err: Error) => {
    broken = err;
    logger.error('Postgres connection lost during a transaction', errorFields(err));
  };
  client.on('error', onConnectionError);
  try {
    const mode = [options.isolation && `ISOLATION LEVEL ${options.isolation.toUpperCase()}`, options.readOnly && 'READ ONLY']
      .filter(Boolean)
      .join(' ');
    await client.query(`BEGIN ${mode}`.trim());
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable. Releasing with an error makes the pool
      // destroy it instead of handing it to the next caller.
      broken ??= rollbackErr as Error;
    }
    // Rethrow the original error, not the rollback failure, so the cause isn't hidden.
    throw err;
  } finally {
    client.off('error', onConnectionError);
    client.release(broken);
  }
}
