import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, startTestApp, type TestApp } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

function history(accountId: string, query = '') {
  return app.request('GET', `/accounts/${accountId}/transactions${query}`);
}

function transfer(from: string, to: string, amount: string) {
  return app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount }, { 'Idempotency-Key': randomUUID() });
}

/** Inserts n transfers from -> to directly, one second apart, oldest first. Returns their ids oldest first. */
async function seedTransfers(from: string, to: string, n: number): Promise<string[]> {
  const rows = await app.query<{ id: string }>(
    `INSERT INTO transfers (from_account_id, to_account_id, amount, created_at)
     SELECT $1, $2, 1, TIMESTAMPTZ '2026-01-01' + g * INTERVAL '1 second'
     FROM generate_series(1, $3::int) g
     ORDER BY g
     RETURNING id`,
    [from, to, n],
  );
  return rows.map((r) => r.id);
}

describe('GET /accounts/:id/transactions', () => {
  test('returns an empty list for an account with no transfers', async () => {
    const id = await app.createAccount('10.00');
    const res = await history(id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { data: [] });
  });

  test('includes transfers in both directions, labelled from the account\'s point of view', async () => {
    const alice = await app.createAccount('100.00');
    const bob = await app.createAccount('100.00');
    const sent = (await transfer(alice, bob, '30.00')).body;
    const received = (await transfer(bob, alice, '12.50')).body;

    const res = await history(alice);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, [
      { ...received, direction: 'credit' },
      { ...sent, direction: 'debit' },
    ]);
    // The same two transfers, seen from Bob's side, have the opposite labels.
    const bobs = (await history(bob)).body.data;
    assert.deepEqual(bobs.map((t: { direction: string }) => t.direction), ['debit', 'credit']);
  });

  test('amounts are strings and every field is present', async () => {
    const a = await app.createAccount('10.00');
    const b = await app.createAccount('0');
    await transfer(a, b, '0.10');
    const [item] = (await history(a)).body.data;
    assert.deepEqual(Object.keys(item).sort(), ['amount', 'created_at', 'direction', 'from_account_id', 'id', 'to_account_id']);
    assert.equal(item.amount, '0.10');
  });

  test('excludes transfers between other accounts', async () => {
    const [a, b, c] = await Promise.all([app.createAccount('50.00'), app.createAccount('50.00'), app.createAccount('50.00')]);
    await transfer(b, c, '5.00');
    await transfer(a, b, '1.00');
    const data = (await history(a)).body.data;
    assert.equal(data.length, 1);
    assert.equal(data[0].to_account_id, b);
  });

  test('orders newest first', async () => {
    const a = await app.createAccount('0');
    const b = await app.createAccount('0');
    const ids = await seedTransfers(a, b, 5);
    const data = (await history(a)).body.data;
    assert.deepEqual(data.map((t: { id: string }) => t.id), ids.reverse());
  });

  test('orders transfers with identical timestamps consistently', async () => {
    const a = await app.createAccount('0');
    const b = await app.createAccount('0');
    await app.query(
      `INSERT INTO transfers (from_account_id, to_account_id, amount, created_at)
       SELECT $1, $2, 1, TIMESTAMPTZ '2026-01-01' FROM generate_series(1, 10)`,
      [a, b],
    );
    const first = (await history(a)).body.data.map((t: { id: string }) => t.id);
    const second = (await history(a)).body.data.map((t: { id: string }) => t.id);
    assert.equal(first.length, 10);
    assert.deepEqual(second, first);
    assert.deepEqual(first, [...first].sort().reverse());
  });

  test('returns the newest 50 by default', async () => {
    const a = await app.createAccount('0');
    const b = await app.createAccount('0');
    const ids = await seedTransfers(a, b, 60);
    const data = (await history(a)).body.data;
    assert.equal(data.length, 50);
    assert.deepEqual(data.map((t: { id: string }) => t.id), ids.slice(10).reverse());
  });

  test('honours limit, from 1 up to 100', async () => {
    const a = await app.createAccount('0');
    const b = await app.createAccount('0');
    const ids = await seedTransfers(a, b, 110);
    assert.deepEqual((await history(a, '?limit=1')).body.data.map((t: { id: string }) => t.id), [ids[109]]);
    assert.equal((await history(a, '?limit=100')).body.data.length, 100);
  });

  test('works with an uppercase account id', async () => {
    const a = await app.createAccount('10.00');
    const b = await app.createAccount('0');
    await transfer(a, b, '1.00');
    const data = (await history(a.toUpperCase())).body.data;
    assert.equal(data.length, 1);
    assert.equal(data[0].direction, 'debit');
  });

  test('returns 404 for an unknown account', async () => {
    const res = await history(MISSING_ID);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'account_not_found', message: 'Account not found' });
  });

  test('returns 400 for a malformed account id', async () => {
    const res = await history('not-a-uuid');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_account_id');
  });

  for (const limit of ['0', '101', '-1', '1.5', 'abc', '', '1000', '1e2', '5&limit=6']) {
    test(`rejects limit=${limit} with 400`, async () => {
      const a = await app.createAccount('0');
      const res = await history(a, `?limit=${limit}`);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'invalid_limit', message: 'limit must be an integer from 1 to 100' });
    });
  }
});
