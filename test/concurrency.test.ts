import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

// Each scenario runs several rounds: a race can hide in any single round,
// especially the first, while the pool is still opening connections.
const ROUNDS = 5;

function transfer(from: string, to: string, amount: string) {
  return app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount });
}

function countStatuses(results: { status: number }[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** Sums balances in SQL so the check itself never uses floating point. */
async function total(ids: string[]): Promise<string> {
  const [row] = await app.query<{ total: string }>('SELECT sum(balance)::text AS total FROM accounts WHERE id = ANY($1::uuid[])', [ids]);
  return row!.total;
}

describe('concurrent transfers', () => {
  test('two concurrent 80.00 transfers from 100.00 to different destinations: exactly one succeeds', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const source = await app.createAccount('100.00');
      const destA = await app.createAccount('0');
      const destB = await app.createAccount('0');

      const results = await Promise.all([transfer(source, destA, '80.00'), transfer(source, destB, '80.00')]);

      assert.deepEqual(countStatuses(results), { 201: 1, 422: 1 }, `round ${round}: ${JSON.stringify(results.map((r) => r.body))}`);
      assert.equal(results.find((r) => r.status === 422)!.body.error, 'insufficient_funds');
      assert.equal(await app.balance(source), '20.00');
      assert.deepEqual([await app.balance(destA), await app.balance(destB)].sort(), ['0.00', '80.00']);
      assert.equal(await total([source, destA, destB]), '100.00');
    }
  });

  test('25 concurrent 1.00 transfers from 10.00: exactly 10 succeed and the balance ends at 0.00', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const source = await app.createAccount('10.00');
      const dest = await app.createAccount('0');

      const results = await Promise.all(Array.from({ length: 25 }, () => transfer(source, dest, '1.00')));

      assert.deepEqual(countStatuses(results), { 201: 10, 422: 15 }, `round ${round}`);
      assert.equal(await app.balance(source), '0.00');
      assert.equal(await app.balance(dest), '10.00');
      const [row] = await app.query<{ count: string }>('SELECT count(*) FROM transfers WHERE from_account_id = $1', [source]);
      assert.equal(row!.count, '10');
    }
  });

  test('100 concurrent opposite transfers between A and B all succeed without deadlocking', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await app.createAccount('1000.00');
      const b = await app.createAccount('1000.00');

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? transfer(a, b, '1.00') : transfer(b, a, '1.00'))),
      );

      assert.deepEqual(countStatuses(results), { 201: 100 }, `round ${round}`);
      // 50 each way, so both balances end where they started.
      assert.equal(await app.balance(a), '1000.00');
      assert.equal(await app.balance(b), '1000.00');
    }
  });

  test('money is conserved across a random mix of concurrent transfers between five accounts', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const accounts = await Promise.all(Array.from({ length: 5 }, () => app.createAccount('20.00')));

      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) => {
          const from = accounts[i % 5]!;
          const to = accounts[(i * 3 + 1 + Math.floor(i / 5)) % 5]!;
          const amount = `${1 + (i % 7)}.${String((i * 13) % 100).padStart(2, '0')}`;
          return from === to ? transfer(from, accounts[(i + 1) % 5]!, amount) : transfer(from, to, amount);
        }),
      );

      // Some fail for lack of funds; none may fail for any other reason.
      for (const r of results) assert.ok(r.status === 201 || r.status === 422, `round ${round}: ${JSON.stringify(r.body)}`);
      assert.equal(await total(accounts), '100.00');
      for (const id of accounts) assert.ok(!(await app.balance(id)).startsWith('-'));
    }
  });
});
