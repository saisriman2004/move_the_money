import 'dotenv/config';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';

/**
 * Tests run against TEST_DATABASE_URL, or DATABASE_URL with "_test" appended
 * to the database name, never the development database itself.
 */
function testDatabaseUrl(): URL {
  if (process.env.TEST_DATABASE_URL) return new URL(process.env.TEST_DATABASE_URL);
  if (!process.env.DATABASE_URL) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run tests');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname}_test`;
  return url;
}

async function ensureDatabaseExists(url: URL): Promise<void> {
  const name = url.pathname.slice(1);
  // The name is interpolated into CREATE DATABASE, so allow only plain identifiers.
  if (!/^\w+$/.test(name)) throw new Error(`Unsupported test database name: ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    // 42P04: already exists. 23505: another test file created it at the same moment.
    const code = (err as { code?: string }).code;
    if (code !== '42P04' && code !== '23505') throw err;
  } finally {
    await client.end();
  }
}

export interface TestApp {
  baseUrl: string;
  query<T extends object = any>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Creates and migrates the test database, then starts the app on a random port. */
export async function startTestApp(): Promise<TestApp> {
  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);
  process.env.DATABASE_URL = url.toString();

  // Imported only now, so config and the pool pick up the test DATABASE_URL.
  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { pool, closePool } = await import('../src/db/index.js');
  await migrate();

  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });

  return {
    baseUrl: `http://localhost:${(server.address() as AddressInfo).port}`,
    async query(sql, params) {
      return (await pool.query(sql, params)).rows;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await closePool();
    },
  };
}
