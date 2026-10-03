import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, startTestApp, type TestApp } from './helpers';

let app: TestApp;
let db: typeof import('../src/db/index.js');

const FUNDING = '00000000-0000-4000-8000-000000000001';
const FEES = '00000000-0000-4000-8000-000000000002';

before(async () => {
  app = await startTestApp();
  db = await import('../src/db/index.js');
});

after(async () => {
  await app.close();
});

function transfer(from: string, to: string, amount: string) {
  return app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount }, { 'Idempotency-Key': randomUUID() });
}

interface Entry {
  account_id: string;
  direction: 'debit' | 'credit';
  amount: string;
}

async function entriesFor(transferId: string): Promise<Entry[]> {
  return app.query<Entry>(
    'SELECT account_id, direction, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY direction DESC',
    [transferId],
  );
}

async function ledgerBalance(accountId: string): Promise<{ balance: string; ledger_balance: string }> {
  const [row] = await app.query<{ balance: string; ledger_balance: string }>(
    'SELECT balance::text, ledger_balance::text FROM account_ledger_balances WHERE account_id = $1',
    [accountId],
  );
  return row!;
}

describe('double-entry ledger', () => {
  test('opening an account posts a deposit: debit funding, credit the new account', async () => {
    const id = await app.createAccount('75.25');
    const [deposit] = await app.query<{ id: string }>("SELECT id FROM transfers WHERE kind = 'deposit' AND to_account_id = $1", [id]);
    assert.deepEqual(await entriesFor(deposit!.id), [
      { account_id: FUNDING, direction: 'debit', amount: '75.25' },
      { account_id: id, direction: 'credit', amount: '75.25' },
    ]);
  });

  test('a transfer posts exactly two equal entries: debit the sender, credit the receiver', async () => {
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount();
    const res = await transfer(a, b, '12.34');
    assert.deepEqual(await entriesFor(res.body.id), [
      { account_id: b, direction: 'credit', amount: '12.34' },
      { account_id: a, direction: 'debit', amount: '12.34' },
    ].sort((x, y) => (x.direction < y.direction ? 1 : -1)));
  });

  test('every balance can be rebuilt from the ledger after a run of transfers', async () => {
    const accounts = await Promise.all([app.createAccount('100.00'), app.createAccount('40.00'), app.createAccount('5.50')]);
    const moves: [number, number, string][] = [[0, 1, '30.00'], [1, 2, '0.01'], [2, 0, '5.51'], [0, 2, '64.49'], [1, 0, '9.99']];
    for (const [from, to, amount] of moves) {
      assert.equal((await transfer(accounts[from]!, accounts[to]!, amount)).status, 201);
    }
    for (const id of accounts) {
      const { balance, ledger_balance } = await ledgerBalance(id);
      assert.equal(ledger_balance, balance, `account ${id}`);
    }
  });

  test('every ledger transfer balances: total debits equal total credits', async () => {
    const unbalanced = await app.query(
      `SELECT transfer_id FROM ledger_entries
        GROUP BY transfer_id
       HAVING sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`,
    );
    assert.deepEqual(unbalanced, []);
  });

  test('a rejected transfer writes no ledger entries', async () => {
    const a = await app.createAccount('10.00');
    const b = await app.createEmptyAccount();
    const before = await app.query('SELECT 1 FROM ledger_entries WHERE account_id = ANY($1::uuid[])', [[a, b]]);
    assert.equal((await transfer(a, b, '10.01')).status, 422);
    const after = await app.query('SELECT 1 FROM ledger_entries WHERE account_id = ANY($1::uuid[])', [[a, b]]);
    assert.equal(after.length, before.length);
  });
});

describe('ledger integrity enforced by the database', () => {
  test('ledger entries cannot be updated or deleted', async () => {
    const a = await app.createAccount('10.00');
    for (const sql of [
      "UPDATE ledger_entries SET amount = 999 WHERE account_id = $1",
      'DELETE FROM ledger_entries WHERE account_id = $1',
    ]) {
      await assert.rejects(app.query(sql, [a]), { message: 'ledger entries are immutable' });
    }
  });

  test('a transfer whose entries do not balance is rejected at commit', async () => {
    const a = await app.createAccount('10.00');
    const b = await app.createEmptyAccount();
    await assert.rejects(
      db.withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'INSERT INTO transfers (from_account_id, to_account_id, amount) VALUES ($1, $2, 5) RETURNING id',
          [a, b],
        );
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
           VALUES ($1, $2, 'debit', 5), ($1, $3, 'credit', 4)`,
          [rows[0]!.id, a, b],
        );
      }),
      { code: '23514', message: /unbalanced: debits 5\.00, credits 4\.00/ },
    );
  });
});

describe('system accounts', () => {
  test('are not listed and cannot receive ordinary transfers', async () => {
    const listed = (await app.request('GET', '/accounts')).body.data.map((a: { id: string }) => a.id);
    assert.ok(!listed.includes(FUNDING) && !listed.includes(FEES));

    const a = await app.createAccount('10.00');
    for (const target of [FUNDING, FEES]) {
      const res = await transfer(a, target, '1.00');
      assert.equal(res.status, 404);
      assert.equal(res.body.message, 'Destination account not found');
    }
    assert.equal(await app.balance(a), '10.00');
  });

  test('the funding account may go negative, customer accounts may not', async () => {
    const [funding] = await app.query<{ balance: string }>('SELECT balance::text FROM accounts WHERE id = $1', [FUNDING]);
    assert.ok(funding!.balance.startsWith('-'));
    const a = await app.createAccount('1.00');
    await assert.rejects(app.query('UPDATE accounts SET balance = -1 WHERE id = $1', [a]), {
      constraint: 'accounts_balance_non_negative',
    });
  });
});

describe('GET /transfers/:id', () => {
  test('returns the transfer with its ledger entries to either party', async () => {
    const other = await app.registerUser();
    const a = await app.createAccount('20.00');
    const b = await app.createEmptyAccount(other.id);
    const created = (await transfer(a, b, '7.00')).body;

    const viewers: Record<string, string>[] = [{}, { authorization: `Bearer ${other.token}` }];
    for (const headers of viewers) {
      const res = await app.request('GET', `/transfers/${created.id}`, undefined, headers);
      assert.equal(res.status, 200);
      assert.equal(res.body.id, created.id);
      assert.equal(res.body.kind, 'transfer');
      assert.deepEqual(
        res.body.ledger_entries.map((e: Entry) => [e.account_id, e.direction, e.amount]),
        [[a, 'debit', '7.00'], [b, 'credit', '7.00']],
      );
    }
  });

  test("returns 404 for someone else's transfer, an unknown id, and 400 for a malformed id", async () => {
    const stranger = await app.registerUser();
    const a = await app.createAccount('20.00');
    const b = await app.createEmptyAccount();
    const created = (await transfer(a, b, '1.00')).body;

    assert.equal((await app.request('GET', `/transfers/${created.id}`, undefined, { authorization: `Bearer ${stranger.token}` })).status, 404);
    assert.equal((await app.request('GET', `/transfers/${MISSING_ID}`)).status, 404);
    assert.equal((await app.request('GET', '/transfers/nope')).status, 400);
  });
});
