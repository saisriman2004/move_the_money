import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;
let recon: typeof import('../src/reconciliation.js');
let db: typeof import('../src/db/index.js');

before(async () => {
  process.env.TRANSFER_FEE_PERCENT = '1';
  app = await startTestApp({ isolatedDatabase: 'reconciliation' });
  recon = await import('../src/reconciliation.js');
  db = await import('../src/db/index.js');
});

after(async () => {
  await app?.close();
});

/**
 * Simulates corruption that got past the application: runs SQL with triggers
 * off (replication role), so even the ledger's own guards don't fire.
 */
async function behindTheLedgersBack(sql: string, params: unknown[] = []) {
  await db.withTransaction(async (client) => {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, params);
  });
}

const transfer = (from: string, to: string, amount: string) =>
  app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount }, { 'Idempotency-Key': randomUUID() });

describe('reconciliation', () => {
  test('a ledger built only through the API reconciles: deposits, fees, refunds and all', async () => {
    const payer = await app.registerUser();
    const payerAccount = (await app.request('POST', '/accounts', { first_name: 'P', last_name: 'Y', starting_balance: '300.00' }, { authorization: `Bearer ${payer.token}` })).body.id;
    const mine = await app.createAccount('50.00');
    const paid = await app.request('POST', '/transfers', { from_account_id: payerAccount, to_account_id: mine, amount: '120.00' }, { authorization: `Bearer ${payer.token}`, 'Idempotency-Key': randomUUID() });
    await transfer(mine, payerAccount, '10.00');
    await app.request('POST', `/transfers/${paid.body.id}/refund`, undefined, { 'Idempotency-Key': randomUUID() });

    const report = await recon.reconcile();
    assert.equal(report.status, 'reconciled', JSON.stringify(report.issues));
    assert.deepEqual(report.issues, []);
    assert.ok(report.accounts_checked >= 4);
    const [stored] = await app.query<{ status: string }>('SELECT status FROM reconciliation_runs WHERE id = $1', [report.id]);
    assert.equal(stored!.status, 'reconciled');
  });

  test('a balance edited outside the ledger is reported, and the totals no longer sum to zero', async () => {
    const a = await app.createAccount('40.00');
    await app.query('UPDATE accounts SET balance = balance + 10 WHERE id = $1', [a]);
    try {
      const report = await recon.reconcile();
      assert.equal(report.status, 'mismatch');
      assert.deepEqual(report.issues.find((i) => i.type === 'balance_mismatch' && i.account_id === a), {
        type: 'balance_mismatch', account_id: a, balance: '50.00', ledger_balance: '40.00',
      });
      assert.deepEqual(report.issues.find((i) => i.type === 'total_not_zero'), { type: 'total_not_zero', total: '10.00' });
    } finally {
      await app.query('UPDATE accounts SET balance = balance - 10 WHERE id = $1', [a]);
    }
    assert.equal((await recon.reconcile()).status, 'reconciled');
  });

  test('an unbalanced transfer is reported', async () => {
    const a = await app.createAccount('40.00');
    const b = await app.createEmptyAccount();
    const { id } = (await transfer(a, b, '5.00')).body;
    // An extra credit with no matching debit, slipped past the commit-time check.
    await behindTheLedgersBack(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'credit', 1)`, [id, b]);
    try {
      const report = await recon.reconcile();
      assert.ok(report.issues.some((i) => i.type === 'unbalanced_transfer' && i.transfer_id === id));
      assert.ok(report.issues.some((i) => i.type === 'balance_mismatch' && i.account_id === b));
    } finally {
      await behindTheLedgersBack(`DELETE FROM ledger_entries WHERE transfer_id = $1 AND direction = 'credit' AND amount = 1`, [id]);
    }
    assert.equal((await recon.reconcile()).status, 'reconciled');
  });

  test("entries that balance but don't match the transfer's amount are reported", async () => {
    const a = await app.createAccount('40.00');
    const b = await app.createEmptyAccount();
    const { id } = (await transfer(a, b, '5.00')).body;
    await behindTheLedgersBack('UPDATE transfers SET amount = 6 WHERE id = $1', [id]);
    try {
      const report = await recon.reconcile();
      assert.deepEqual(report.issues.find((i) => i.type === 'entries_do_not_match_amount'), {
        type: 'entries_do_not_match_amount', transfer_id: id, amount_plus_fee: '6.05', debits: '5.05',
      });
    } finally {
      await behindTheLedgersBack('UPDATE transfers SET amount = 5 WHERE id = $1', [id]);
    }
  });

  test('a transfer with no ledger entries at all is reported', async () => {
    const a = await app.createEmptyAccount();
    const b = await app.createEmptyAccount();
    const [row] = await app.query<{ id: string }>('INSERT INTO transfers (from_account_id, to_account_id, amount) VALUES ($1, $2, 1) RETURNING id', [a, b]);
    try {
      const report = await recon.reconcile();
      assert.ok(report.issues.some((i) => i.type === 'missing_ledger_entries' && i.transfer_id === row!.id));
    } finally {
      await app.query('DELETE FROM transfers WHERE id = $1', [row!.id]);
    }
    assert.equal((await recon.reconcile()).status, 'reconciled');
  });

  // Holds because each check is one statement over a consistent snapshot. (Removing the
  // REPEATABLE READ transaction doesn't break this test, for the same reason.)
  test('runs during heavy concurrent transfers never report a false mismatch', async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, () => app.createAccount('500.00')));
    const traffic = Promise.all(
      Array.from({ length: 60 }, (_, i) => transfer(accounts[i % 6]!, accounts[(i + 1 + (i % 4)) % 6]!, `${1 + (i % 5)}.${String(i % 100).padStart(2, '0')}`)),
    );
    const runs = Promise.all(Array.from({ length: 8 }, async (_, i) => {
      await new Promise((resolve) => setTimeout(resolve, i * 15));
      return recon.reconcile();
    }));
    const [, reports] = await Promise.all([traffic, runs]);
    for (const r of reports) assert.equal(r.status, 'reconciled', JSON.stringify(r.issues));
  });
});
