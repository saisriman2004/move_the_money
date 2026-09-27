import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;
let db: typeof import('../src/db/index.js');
let migrations: typeof import('../src/db/migrate.js');

before(async () => {
  app = await startTestApp();
  db = await import('../src/db/index.js');
  migrations = await import('../src/db/migrate.js');
});

after(async () => {
  await app.close();
});

/** Inserts an account directly and returns its id. */
async function insertAccount(balance = '0.00'): Promise<string> {
  const [row] = await app.query<{ id: string }>(
    `INSERT INTO accounts (first_name, last_name, balance) VALUES ('Ada', 'Lovelace', $1) RETURNING id`,
    [balance],
  );
  return row!.id;
}

/** Runs sql and returns the name of the constraint it violated. */
async function violatedConstraint(sql: string, params: unknown[]): Promise<string | undefined> {
  try {
    await app.query(sql, params);
  } catch (err) {
    return (err as { constraint?: string }).constraint;
  }
  assert.fail('expected the statement to violate a constraint');
}

describe('migrations', () => {
  test('create the accounts and transfers tables and record each migration', async () => {
    const tables = await app.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('accounts', 'transfers')
        ORDER BY table_name`,
    );
    assert.deepEqual(tables.map((t) => t.table_name), ['accounts', 'transfers']);

    const recorded = await app.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    assert.deepEqual(recorded.map((r) => r.name), ['001_initial_schema.sql', '002_transfer_idempotency_keys.sql']);
  });

  test('running them again is a no-op', async () => {
    assert.deepEqual(await migrations.migrate(), []);
    const [row] = await app.query<{ count: string }>('SELECT count(*) FROM schema_migrations');
    assert.equal(row!.count, '2');
  });

  test('concurrent runners do not collide', async () => {
    const results = await Promise.all([migrations.migrate(), migrations.migrate(), migrations.migrate()]);
    assert.deepEqual(results, [[], [], []]);
  });
});

describe('schema constraints', () => {
  test('balance is returned as an exact decimal string', async () => {
    const id = await insertAccount('100.1');
    const [row] = await app.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [id]);
    assert.equal(row!.balance, '100.10');
  });

  test('balance cannot go negative', async () => {
    const id = await insertAccount('5.00');
    assert.equal(
      await violatedConstraint('UPDATE accounts SET balance = balance - 5.01 WHERE id = $1', [id]),
      'accounts_balance_non_negative',
    );
  });

  for (const [label, name] of [
    ['empty', ''],
    ['over 100 characters', 'a'.repeat(101)],
  ] as const) {
    test(`first_name rejects ${label}`, async () => {
      assert.equal(
        await violatedConstraint(`INSERT INTO accounts (first_name, last_name, balance) VALUES ($1, 'L', 0)`, [name]),
        'accounts_first_name_valid',
      );
    });
  }

  test('last_name rejects empty', async () => {
    assert.equal(
      await violatedConstraint(`INSERT INTO accounts (first_name, last_name, balance) VALUES ('A', $1, 0)`, ['']),
      'accounts_last_name_valid',
    );
  });

  test('names are required', async () => {
    await assert.rejects(
      app.query(`INSERT INTO accounts (first_name, last_name, balance) VALUES (NULL, 'L', 0)`),
      { code: '23502' }, // not_null_violation
    );
  });

  test('a name of exactly 100 characters with an inner space is accepted', async () => {
    const name = `Mary ${'a'.repeat(95)}`;
    const [row] = await app.query<{ first_name: string }>(
      `INSERT INTO accounts (first_name, last_name, balance) VALUES ($1, 'L', 0) RETURNING first_name`,
      [name],
    );
    assert.equal(row!.first_name, name);
  });

  test('transfers reject zero amounts and self-transfers', async () => {
    const a = await insertAccount();
    const b = await insertAccount();
    const insert = 'INSERT INTO transfers (from_account_id, to_account_id, amount) VALUES ($1, $2, $3)';
    assert.equal(await violatedConstraint(insert, [a, b, '0']), 'transfers_amount_positive');
    assert.equal(await violatedConstraint(insert, [a, a, '1']), 'transfers_distinct_accounts');
  });

  test('transfers must reference existing accounts', async () => {
    const a = await insertAccount();
    await assert.rejects(
      app.query('INSERT INTO transfers (from_account_id, to_account_id, amount) VALUES ($1, gen_random_uuid(), 1)', [a]),
      { code: '23503' }, // foreign_key_violation
    );
  });
});

describe('withTransaction', () => {
  test('commits when the callback succeeds', async () => {
    const id = await db.withTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO accounts (first_name, last_name, balance) VALUES ('C', 'Commit', 1) RETURNING id`,
      );
      return res.rows[0]!.id;
    });
    assert.equal((await app.query('SELECT 1 FROM accounts WHERE id = $1', [id])).length, 1);
  });

  test('rolls back every statement when the callback throws', async () => {
    const id = await insertAccount('50.00');
    await assert.rejects(
      db.withTransaction(async (client) => {
        await client.query('UPDATE accounts SET balance = balance - 20 WHERE id = $1', [id]);
        throw new Error('boom');
      }),
      /boom/,
    );
    const [row] = await app.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [id]);
    assert.equal(row!.balance, '50.00');
  });

  test('rolls back when a statement fails inside the transaction', async () => {
    const id = await insertAccount('10.00');
    await assert.rejects(
      db.withTransaction(async (client) => {
        await client.query(`UPDATE accounts SET first_name = 'Changed' WHERE id = $1`, [id]);
        await client.query('UPDATE accounts SET balance = -1 WHERE id = $1', [id]);
      }),
      { constraint: 'accounts_balance_non_negative' },
    );
    const [row] = await app.query<{ first_name: string }>('SELECT first_name FROM accounts WHERE id = $1', [id]);
    assert.equal(row!.first_name, 'Ada');
  });

  test('a connection killed while a query is running fails the request instead of crashing the process', async () => {
    let killedPid: number | undefined;
    await assert.rejects(
      db.withTransaction(async (client) => {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        killedPid = rows[0]!.pid;
        const running = client.query('SELECT pg_sleep(5)');
        // Wait until the sleep is actually running, then kill the connection under it.
        while ((await app.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND query LIKE '%pg_sleep%'`, [killedPid])).length === 0);
        await app.query('SELECT pg_terminate_backend($1)', [killedPid]);
        await running;
      }),
    );
    // Give a stray 'error' event time to fire; without a listener it would kill this process.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [row] = await app.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.notEqual(row!.pid, killedPid);
  });

  test('if ROLLBACK fails, rethrows the original error and the pool discards the connection', async () => {
    let killedPid: number | undefined;
    await assert.rejects(
      db.withTransaction(async (client) => {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        killedPid = rows[0]!.pid;
        // Kill this transaction's connection from another one, so ROLLBACK cannot succeed.
        await app.query('SELECT pg_terminate_backend($1)', [killedPid]);
        throw new Error('original failure');
      }),
      /original failure/,
    );

    // The pool must not hand the dead connection out again.
    for (let i = 0; i < 10; i++) {
      const [row] = await app.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      assert.notEqual(row!.pid, killedPid);
    }
  });
});
