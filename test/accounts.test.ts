import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, startTestApp, type TestApp } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

const valid = { first_name: 'Ada', last_name: 'Lovelace', starting_balance: '100.00' };

function create(body: unknown) {
  return app.request('POST', '/accounts', body);
}

describe('POST /accounts', () => {
  test('creates an account and returns it with 201', async () => {
    const res = await create(valid);
    assert.equal(res.status, 201);
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.first_name, 'Ada');
    assert.equal(res.body.last_name, 'Lovelace');
    assert.equal(res.body.balance, '100.00');
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
  });

  test('returns the balance with exactly two decimals', async () => {
    const res = await create({ ...valid, starting_balance: '100.5' });
    assert.equal(res.status, 201);
    assert.equal(res.body.balance, '100.50');
  });

  test('rejects a JSON number balance and asks for a string', async () => {
    // 0.1 + 0.2 is 0.30000000000000004: floating point is why amounts must be strings.
    const res = await create({ ...valid, starting_balance: 0.1 + 0.2 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: 'invalid_amount',
      message: 'starting_balance must be a string, e.g. "100.00"',
    });
  });

  for (const [label, value] of [
    ['zero', '0'],
    ['negative', '-1'],
    ['three decimals', '1.005'],
    ['exponent', '1e3'],
    ['19 integer digits', '1000000000000000000'],
  ] as const) {
    test(`rejects starting_balance: ${label}`, async () => {
      const res = await create({ ...valid, starting_balance: value });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_amount');
    });
  }

  test('trims names before saving', async () => {
    const res = await create({ ...valid, first_name: '  Ada ', last_name: '\tLovelace\n' });
    assert.equal(res.status, 201);
    assert.equal(res.body.first_name, 'Ada');
    assert.equal(res.body.last_name, 'Lovelace');
  });

  test('counts name length in characters, not UTF-16 units', async () => {
    // 100 emoji are 100 characters but 200 UTF-16 units; Postgres counts characters too.
    assert.equal((await create({ ...valid, first_name: '😀'.repeat(100) })).status, 201);
    assert.equal((await create({ ...valid, first_name: '😀'.repeat(101) })).status, 400);
  });

  for (const [label, value] of [
    ['whitespace-only', '   '],
    ['over 100 characters', 'a'.repeat(101)],
    ['not a string', 42],
  ] as const) {
    test(`rejects first_name: ${label}`, async () => {
      const res = await create({ ...valid, first_name: value });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_name');
    });
  }

  test('rejects a missing field', async () => {
    const { starting_balance: _, ...body } = valid;
    const res = await create(body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'missing_field', message: 'starting_balance is required' });
  });

  test('rejects unknown fields', async () => {
    const res = await create({ ...valid, balance: '5' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'unknown_field', message: 'Unknown field(s): balance' });
  });

  test('rejects a body that is not a JSON object', async () => {
    const res = await create([valid]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_body');
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await create('{"first_name": "Ada",');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'malformed_json', message: 'Request body is not valid JSON' });
  });

  test('rejects an oversized body with 413', async () => {
    const res = await create({ ...valid, first_name: 'a'.repeat(200_000) });
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'payload_too_large');
  });

  test('a rejected request creates no account', async () => {
    // Other test files create accounts in parallel, so count only ones with this unique name.
    const marker = `reject-${Date.now()}-${Math.random()}`;
    await create({ ...valid, last_name: marker, starting_balance: '-5' });
    await create({ ...valid, last_name: marker, first_name: '' });
    const rows = await app.query<{ count: string }>('SELECT count(*) FROM accounts WHERE last_name = $1', [marker]);
    assert.equal(rows[0]!.count, '0');
  });
});

describe('GET /accounts/:id', () => {
  test('returns the account', async () => {
    const created = (await create(valid)).body;
    const res = await app.request('GET', `/accounts/${created.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created);
  });

  test('returns 404 for an unknown account', async () => {
    const res = await app.request('GET', `/accounts/${MISSING_ID}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'account_not_found', message: 'Account not found' });
  });

  test('returns 400, not 500, for a malformed id', async () => {
    const res = await app.request('GET', '/accounts/not-a-uuid');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalid_account_id', message: 'Account id must be a UUID' });
  });
});
