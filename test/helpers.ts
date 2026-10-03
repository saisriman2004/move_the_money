import 'dotenv/config';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Tests run against TEST_DATABASE_URL, or DATABASE_URL with "_test" appended
 * to the database name, never the development database itself.
 */
function testDatabaseUrl(isolated?: string): URL {
  let url: URL;
  if (process.env.TEST_DATABASE_URL) {
    url = new URL(process.env.TEST_DATABASE_URL);
  } else {
    if (!process.env.DATABASE_URL) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run tests');
    url = new URL(process.env.DATABASE_URL);
    url.pathname = `${url.pathname}_test`;
  }
  if (isolated) url.pathname = `${url.pathname}_${isolated}`;
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

export const TEST_JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export interface TestApp {
  baseUrl: string;
  /** The user every request is authenticated as, unless a test passes its own Authorization header. */
  user: TestUser;
  /** Registers another user through the API. */
  registerUser(): Promise<TestUser>;
  /** Sends a JSON request. A string body is sent as-is, so tests can send malformed JSON. */
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Creates an account through the API and returns its id. The balance must be greater than zero. */
  createAccount(startingBalance: string): Promise<string>;
  /**
   * Inserts an account with a 0.00 balance directly into the database. The API
   * only opens accounts with money in them, but 0.00 is a valid state (an
   * account can spend down to it), and transfer tests need empty destinations.
   */
  createEmptyAccount(ownerId?: string): Promise<string>;
  /** Reads an account's balance straight from the database. */
  balance(accountId: string): Promise<string>;
  query<T extends object = any>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * Use a database of this test file's own (e.g. "outbox" → move_money_test_outbox).
   * Needed by tests that process every row of a table, such as the outbox relay,
   * so that test files running in parallel don't consume each other's rows.
   */
  isolatedDatabase?: string;
}

/** Creates and migrates the test database, then starts the app on a random port. */
export async function startTestApp(options: StartOptions = {}): Promise<TestApp> {
  const url = testDatabaseUrl(options.isolatedDatabase);
  await ensureDatabaseExists(url);
  process.env.DATABASE_URL = url.toString();
  // Keep test output readable; a test that checks logging turns it back on.
  process.env.LOG_LEVEL ??= 'silent';
  // Always the same secret, whatever a local .env says, so tests can mint their own tokens.
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  // Each test process gets its own Redis keys, and limits high enough not to interfere.
  // Tests of the limiter itself set their own values before starting.
  process.env.REDIS_PREFIX ??= `test:${process.pid}:${Date.now()}:`;
  process.env.RATE_LIMIT_PER_MINUTE ??= '1000000';
  process.env.AUTH_RATE_LIMIT_PER_MINUTE ??= '1000000';
  // Permissive risk rules, so stress tests and large amounts aren't declined;
  // the risk tests set strict ones.
  process.env.RISK_REJECT_AMOUNT ??= '999999999999999999.99';
  process.env.RISK_MAX_TRANSFERS_PER_MINUTE ??= '1000000';
  process.env.RISK_MAX_RECENT_REJECTIONS ??= '1000000';

  // Imported only now, so config and the pool pick up the test DATABASE_URL.
  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { pool, closePool } = await import('../src/db/index.js');
  const { closeRedis } = await import('../src/redis.js');
  await migrate();

  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });

  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const app: TestApp = {
    baseUrl,
    user: { id: '', email: '', token: '' },
    async registerUser() {
      const email = `user-${randomUUID()}@example.test`;
      const res = await app.request('POST', '/auth/register', { email, password: 'correct horse battery' }, { authorization: '' });
      if (res.status !== 201) throw new Error(`registerUser failed: ${JSON.stringify(res.body)}`);
      return { id: res.body.user.id, email, token: res.body.token };
    },
    async request(method, path, body, headers = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${app.user.token}`, ...headers },
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
    async createEmptyAccount(ownerId = app.user.id) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (user_id, first_name, last_name, balance) VALUES ($1, 'Test', 'User', 0) RETURNING id`,
        [ownerId],
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
      await closeRedis();
    },
  };
  app.user = await app.registerUser();
  return app;
}

/** A valid UUID that no account will ever have. */
export const MISSING_ID = '00000000-0000-0000-0000-000000000000';
