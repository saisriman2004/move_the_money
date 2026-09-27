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

  for (const [input, stored] of [
    ['100', '100.00'],
    ['100.5', '100.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ] as const) {
    test(`accepts string balance "${input}" and returns "${stored}"`, async () => {
      const res = await create({ ...valid, starting_balance: input });
      assert.equal(res.status, 201);
      assert.equal(res.body.balance, stored);
    });
  }

  for (const [label, value] of [
    ['integer', 100],
    ['decimal', 100.5],
    ['zero', 0],
    ['imprecise float', 0.1 + 0.2],
  ] as const) {
    test(`rejects a JSON number starting_balance (${label}) and asks for a string`, async () => {
      const res = await create({ ...valid, starting_balance: value });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        error: 'invalid_amount',
        message: 'starting_balance must be a string, e.g. "100.00"',
      });
    });
  }

  test('trims names before saving', async () => {
    const res = await create({ ...valid, first_name: '  Ada ', last_name: '\tLovelace\n' });
    assert.equal(res.status, 201);
    assert.equal(res.body.first_name, 'Ada');
    assert.equal(res.body.last_name, 'Lovelace');
  });

  test('keeps inner spaces and non-ASCII characters in names', async () => {
    const res = await create({ ...valid, first_name: 'Mary Ann', last_name: 'Østergård-Nguyễn' });
    assert.equal(res.status, 201);
    assert.equal(res.body.first_name, 'Mary Ann');
    assert.equal(res.body.last_name, 'Østergård-Nguyễn');
  });

  test('counts name length in characters, not UTF-16 units', async () => {
    // 100 emoji are 100 characters but 200 UTF-16 units.
    const res = await create({ ...valid, first_name: '😀'.repeat(100) });
    assert.equal(res.status, 201);
    assert.equal((await create({ ...valid, first_name: '😀'.repeat(101) })).status, 400);
  });

  for (const field of ['first_name', 'last_name', 'starting_balance'] as const) {
    test(`rejects a missing ${field}`, async () => {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      const res = await create(body);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'missing_field', message: `${field} is required` });
    });
  }

  for (const [label, value] of [
    ['negative', '-1'],
    ['three decimals', '1.005'],
    ['exponent', '1e3'],
    ['letters', 'abc'],
    ['null', null],
    ['empty string', ''],
    ['leading space', ' 100'],
    ['comma separator', '1,000'],
    ['trailing dot', '100.'],
    ['leading dot', '.5'],
    ['19 integer digits', '1000000000000000000'],
    ['boolean', true],
    ['array', ['100']],
    ['object', { amount: '100' }],
  ] as const) {
    test(`rejects starting_balance: ${label}`, async () => {
      const res = await create({ ...valid, starting_balance: value });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_amount');
      assert.equal(typeof res.body.message, 'string');
    });
  }

  for (const [label, value] of [
    ['empty', ''],
    ['whitespace-only', '   '],
    ['tabs and newlines only', '\t\n'],
    ['over 100 characters', 'a'.repeat(101)],
    ['a number', 42],
    ['null', null],
    ['an array', ['Ada']],
  ] as const) {
    test(`rejects first_name: ${label}`, async () => {
      const res = await create({ ...valid, first_name: value });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_name');
    });
  }

  test('rejects an invalid last_name', async () => {
    const res = await create({ ...valid, last_name: '  ' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalid_name', message: 'last_name must be 1 to 100 characters' });
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

  test('rejects a request with no body', async () => {
    const res = await create(undefined);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_field');
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
    const before = await app.query<{ count: string }>('SELECT count(*) FROM accounts');
    await create({ ...valid, starting_balance: '-5' });
    await create({ ...valid, first_name: '' });
    const after = await app.query<{ count: string }>('SELECT count(*) FROM accounts');
    assert.equal(after[0]!.count, before[0]!.count);
  });
});

describe('GET /accounts/:id', () => {
  test('returns the account', async () => {
    const created = (await create(valid)).body;
    const res = await app.request('GET', `/accounts/${created.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created);
  });

  test('accepts an uppercase id', async () => {
    const created = (await create(valid)).body;
    const res = await app.request('GET', `/accounts/${created.id.toUpperCase()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.id);
  });

  test('returns 404 for an unknown account', async () => {
    const res = await app.request('GET', `/accounts/${MISSING_ID}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'account_not_found', message: 'Account not found' });
  });

  for (const id of ['not-a-uuid', '123', `${MISSING_ID}0`, "' OR 1=1 --"]) {
    test(`returns 400, not 500, for malformed id ${JSON.stringify(id)}`, async () => {
      const res = await app.request('GET', `/accounts/${encodeURIComponent(id)}`);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'invalid_account_id', message: 'Account id must be a UUID' });
    });
  }
});
