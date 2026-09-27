import { Pool, type PoolClient } from 'pg';
import { config } from '../config';

// NUMERIC columns come back from pg as strings. We keep them that way so
// money values never pass through JavaScript floating point.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

pool.on('error', (err) => {
  // An idle client lost its connection. The pool discards it; log and move on.
  console.error('Unexpected error on idle Postgres client', err);
});

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Runs fn inside a single database transaction on one dedicated client.
 * Commits if fn resolves, rolls back if it throws, and always returns the
 * client to the pool.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable. Releasing with an error makes the pool
      // destroy it instead of handing it to the next caller.
      broken = rollbackErr as Error;
    }
    // Rethrow the original error, not the rollback failure, so the cause isn't hidden.
    throw err;
  } finally {
    client.release(broken);
  }
}
