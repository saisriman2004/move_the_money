import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

function transfer(body: { from: string; to: string; amount: string }, key?: string) {
  return app.request(
    'POST',
    '/transfers',
    { from_account_id: body.from, to_account_id: body.to, amount: body.amount },
    key === undefined ? {} : { 'Idempotency-Key': key },
  );
}

async function transferCount(key: string): Promise<number> {
  const [row] = await app.query<{ count: string }>('SELECT count(*) FROM transfers WHERE idempotency_key = $1', [key]);
  return Number(row!.count);
}

describe('Idempotency-Key on POST /transfers', () => {
  test('a replay returns the original transfer and moves money only once', async () => {
    const from = await app.createAccount('100.00');
    const to = await app.createEmptyAccount();
    const key = randomUUID();

    const first = await transfer({ from, to, amount: '30.00' }, key);
    const second = await transfer({ from, to, amount: '30.00' }, key);

    assert.equal(first.status, 201);
    assert.equal(first.headers.get('Idempotent-Replayed'), null);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('Idempotent-Replayed'), 'true');
    assert.deepEqual(second.body, first.body);
    assert.equal(await app.balance(from), '70.00');
    assert.equal(await app.balance(to), '30.00');
    assert.equal(await transferCount(key), 1);
  });

  for (const [first, second] of [
    ['100', '100.00'],
    ['100.00', '100'],
    ['100.5', '100.50'],
  ] as const) {
    test(`"${first}" then "${second}" count as the same request`, async () => {
      const from = await app.createAccount('500.00');
      const to = await app.createEmptyAccount();
      const key = randomUUID();

      const a = await transfer({ from, to, amount: first }, key);
      const b = await transfer({ from, to, amount: second }, key);

      assert.equal(b.status, 201);
      assert.equal(b.headers.get('Idempotent-Replayed'), 'true');
      assert.equal(b.body.id, a.body.id);
      assert.equal(await app.balance(to), a.body.amount);
    });
  }

  test('uppercase account ids count as the same request', async () => {
    const from = await app.createAccount('50.00');
    const to = await app.createEmptyAccount();
    const key = randomUUID();

    const first = await transfer({ from, to, amount: '5' }, key);
    const second = await transfer({ from: from.toUpperCase(), to: to.toUpperCase(), amount: '5' }, key);

    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id);
    assert.equal(await app.balance(from), '45.00');
  });

  for (const [label, change] of [
    ['a different amount', (b: { from: string; to: string; amount: string }) => ({ ...b, amount: '11.00' })],
    ['a different destination', (b: { from: string; to: string; amount: string }, other: string) => ({ ...b, to: other })],
    ['swapped accounts', (b: { from: string; to: string; amount: string }) => ({ ...b, from: b.to, to: b.from })],
  ] as const) {
    test(`reusing a key with ${label} returns 409 and moves nothing`, async () => {
      const from = await app.createAccount('100.00');
      const to = await app.createAccount('100.00');
      const other = await app.createEmptyAccount();
      const key = randomUUID();
      const original = { from, to, amount: '10.00' };
      assert.equal((await transfer(original, key)).status, 201);

      const res = await transfer(change(original, other), key);

      assert.equal(res.status, 409);
      assert.deepEqual(res.body, {
        error: 'idempotency_key_conflict',
        message: 'Idempotency-Key was already used for a transfer with different parameters',
      });
      assert.equal(await app.balance(from), '90.00');
      assert.equal(await app.balance(to), '110.00');
      assert.equal(await app.balance(other), '0.00');
      assert.equal(await transferCount(key), 1);
    });
  }

  test('a failed request does not consume its key', async () => {
    const from = await app.createAccount('10.00');
    const to = await app.createEmptyAccount();
    const key = randomUUID();

    const failed = await transfer({ from, to, amount: '25.00' }, key);
    assert.equal(failed.status, 422);
    assert.equal(await transferCount(key), 0);

    // Top up, then retry with the same key: it runs for real this time.
    await app.query(`UPDATE accounts SET balance = 50 WHERE id = $1`, [from]);
    const retried = await transfer({ from, to, amount: '25.00' }, key);
    assert.equal(retried.status, 201);
    assert.equal(retried.headers.get('Idempotent-Replayed'), null);
    assert.equal(await app.balance(from), '25.00');
  });

  test('a transfer without a key is rejected and moves nothing', async () => {
    // Without a key, a retry and a second intentional transfer look identical,
    // so the API refuses to guess: sending the same transfer twice can't apply it twice.
    const from = await app.createAccount('10.00');
    const to = await app.createEmptyAccount();
    for (let i = 0; i < 2; i++) {
      const res = await transfer({ from, to, amount: '1' });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'missing_idempotency_key', message: 'Idempotency-Key header is required' });
    }
    assert.equal(await app.balance(from), '10.00');
  });

  test('keys are case-sensitive', async () => {
    const from = await app.createAccount('10.00');
    const to = await app.createEmptyAccount();
    const key = `Key-${randomUUID()}`;
    const a = await transfer({ from, to, amount: '1' }, key);
    const b = await transfer({ from, to, amount: '1' }, key.toLowerCase());
    assert.notEqual(a.body.id, b.body.id);
    assert.equal(await app.balance(from), '8.00');
  });

  for (const [label, key] of [
    ['empty', ''],
    ['containing a space', 'abc def'],
    ['non-ASCII', 'clé-123'],
    ['over 255 characters', 'k'.repeat(256)],
  ] as const) {
    test(`rejects a key that is ${label} with 400 and moves nothing`, async () => {
      const from = await app.createAccount('10.00');
      const to = await app.createEmptyAccount();
      const res = await transfer({ from, to, amount: '1' }, key);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_idempotency_key');
      assert.equal(await app.balance(from), '10.00');
    });
  }

  test('accepts a key of exactly 255 printable characters', async () => {
    const from = await app.createAccount('10.00');
    const to = await app.createEmptyAccount();
    const res = await transfer({ from, to, amount: '1' }, `${randomUUID()}${'~'.repeat(219)}`);
    assert.equal(res.status, 201);
  });
});

describe('Idempotency-Key under concurrency', () => {
  test('20 concurrent requests with one key make one transfer and one debit', async () => {
    // Several rounds: in the first, the pool is still opening connections, which
    // can serialize the requests by accident and hide a race.
    for (let round = 0; round < 5; round++) {
      const from = await app.createAccount('100.00');
      const to = await app.createEmptyAccount();
      const key = randomUUID();

      const results = await Promise.all(Array.from({ length: 20 }, () => transfer({ from, to, amount: '7.00' }, key)));

      assert.deepEqual(results.map((r) => r.status), Array(20).fill(201), `round ${round}`);
      assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
      assert.equal(results.filter((r) => r.headers.get('Idempotent-Replayed') === 'true').length, 19);
      assert.equal(await app.balance(from), '93.00');
      assert.equal(await app.balance(to), '7.00');
      assert.equal(await transferCount(key), 1);
    }
  });

  test('one key used concurrently for two different transfers gives one 201 and one 409', async () => {
    // The two requests touch different accounts, so the account row locks never make them wait
    // for each other. Only the lock on the key itself turns the loser into a clean 409
    // instead of a unique-constraint 500.
    for (let round = 0; round < 5; round++) {
      const [a, c] = await Promise.all([app.createAccount('100.00'), app.createAccount('100.00')]);
      const [b, d] = await Promise.all([app.createEmptyAccount(), app.createEmptyAccount()]);
      const key = randomUUID();

      const results = await Promise.all([
        transfer({ from: a, to: b, amount: '10.00' }, key),
        transfer({ from: c, to: d, amount: '10.00' }, key),
      ]);

      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], `round ${round}: ${JSON.stringify(results.map((r) => r.body))}`);
      assert.equal(await transferCount(key), 1);
      // Only the winner's money moved.
      const moved = [await app.balance(a), await app.balance(c)].sort();
      assert.deepEqual(moved, ['100.00', '90.00'].sort());
    }
  });

  test('two concurrent retries that spend the whole balance both get the transfer, not insufficient_funds', async () => {
    // The case that rules out "insert, catch the unique violation, re-read":
    // the retry would fail its balance check before ever reaching the insert.
    for (let round = 0; round < 10; round++) {
      const from = await app.createAccount('100.00');
      const to = await app.createEmptyAccount();
      const key = randomUUID();

      const [a, b] = await Promise.all([
        transfer({ from, to, amount: '100.00' }, key),
        transfer({ from, to, amount: '100.00' }, key),
      ]);

      assert.deepEqual([a.status, b.status], [201, 201], JSON.stringify([a.body, b.body]));
      assert.equal(a.body.id, b.body.id);
      assert.equal(await app.balance(from), '0.00');
      assert.equal(await app.balance(to), '100.00');
    }
  });
});
