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

export interface Response {
  status: number;
  headers: Headers;
  body: any;
}

export interface TestApp {
  baseUrl: string;
  /** Sends a JSON request. A string body is sent as-is, so tests can send malformed JSON. */
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Creates an account through the API and returns its id. The balance must be greater than zero. */
  createAccount(startingBalance: string): Promise<string>;
  /**
   * Inserts an account with a 0.00 balance directly into the database. The API
   * only opens accounts with money in them, but 0.00 is a valid state (an
   * account can spend down to it), and transfer tests need empty destinations.
   */
  createEmptyAccount(): Promise<string>;
  /** Reads an account's balance straight from the database. */
  balance(accountId: string): Promise<string>;
  query<T extends object = any>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Creates and migrates the test database, then starts the app on a random port. */
export async function startTestApp(): Promise<TestApp> {
  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);
  process.env.DATABASE_URL = url.toString();
  // Keep test output readable; a test that checks logging turns it back on.
  process.env.LOG_LEVEL ??= 'silent';

  // Imported only now, so config and the pool pick up the test DATABASE_URL.
  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { pool, closePool } = await import('../src/db/index.js');
  await migrate();

  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });

  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const app: TestApp = {
    baseUrl,
    async request(method, path, body, headers = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
    },
    async createAccount(startingBalance) {
      const res = await app.request('POST', '/accounts', {
        first_name: 'Test',
        last_name: 'User',
        starting_balance: startingBalance,
      });
      if (res.status !== 201) throw new Error(`createAccount failed: ${JSON.stringify(res.body)}`);
      return res.body.id;
    },
    async createEmptyAccount() {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (first_name, last_name, balance) VALUES ('Test', 'User', 0) RETURNING id`,
      );
      return rows[0]!.id;
    },
    async balance(accountId) {
      const { rows } = await pool.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [accountId]);
      if (!rows[0]) throw new Error(`No account ${accountId}`);
      return rows[0].balance;
    },
    async query(sql, params) {
      return (await pool.query(sql, params)).rows;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await closePool();
    },
  };
  return app;
}

/** A valid UUID that no account will ever have. */
export const MISSING_ID = '00000000-0000-0000-0000-000000000000';
