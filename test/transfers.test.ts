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

function transfer(body: unknown) {
  return app.request('POST', '/transfers', body);
}

async function transferCount(accountId: string): Promise<number> {
  const [row] = await app.query<{ count: string }>(
    'SELECT count(*) FROM transfers WHERE from_account_id = $1 OR to_account_id = $1',
    [accountId],
  );
  return Number(row!.count);
}

describe('POST /transfers', () => {
  test('moves the exact amount and returns the transfer with 201', async () => {
    const from = await app.createAccount('100.00');
    const to = await app.createAccount('5.00');

    const res = await transfer({ from_account_id: from, to_account_id: to, amount: '30.25' });

    assert.equal(res.status, 201);
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.from_account_id, from);
    assert.equal(res.body.to_account_id, to);
    assert.equal(res.body.amount, '30.25');
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
    assert.equal(await app.balance(from), '69.75');
    assert.equal(await app.balance(to), '35.25');
  });

  test('records the transfer in the database', async () => {
    const from = await app.createAccount('10.00');
    const to = await app.createAccount('0');
    const res = await transfer({ from_account_id: from, to_account_id: to, amount: '1' });
    const rows = await app.query('SELECT from_account_id, to_account_id, amount FROM transfers WHERE id = $1', [res.body.id]);
    assert.deepEqual(rows, [{ from_account_id: from, to_account_id: to, amount: '1.00' }]);
  });

  test('can transfer the entire balance, leaving exactly 0.00', async () => {
    const from = await app.createAccount('42.42');
    const to = await app.createAccount('0');
    assert.equal((await transfer({ from_account_id: from, to_account_id: to, amount: '42.42' })).status, 201);
    assert.equal(await app.balance(from), '0.00');
    assert.equal(await app.balance(to), '42.42');
  });

  test('has no floating-point drift across many small transfers', async () => {
    const from = await app.createAccount('1.00');
    const to = await app.createAccount('0');
    for (let i = 0; i < 10; i++) {
      assert.equal((await transfer({ from_account_id: from, to_account_id: to, amount: '0.10' })).status, 201);
    }
    assert.equal(await app.balance(from), '0.00');
    assert.equal(await app.balance(to), '1.00');
  });

  test('handles amounts beyond JavaScript number precision exactly', async () => {
    const from = await app.createAccount('999999999999999999.99');
    const to = await app.createAccount('0.01');
    const res = await transfer({ from_account_id: from, to_account_id: to, amount: '123456789012345678.91' });
    assert.equal(res.status, 201);
    assert.equal(res.body.amount, '123456789012345678.91');
    assert.equal(await app.balance(from), '876543210987654321.08');
    assert.equal(await app.balance(to), '123456789012345678.92');
  });

  test('accepts uppercase account ids', async () => {
    const from = await app.createAccount('10.00');
    const to = await app.createAccount('0');
    const res = await transfer({ from_account_id: from.toUpperCase(), to_account_id: to.toUpperCase(), amount: '1' });
    assert.equal(res.status, 201);
    assert.equal(res.body.from_account_id, from);
    assert.equal(await app.balance(from), '9.00');
  });

  test('insufficient funds returns 422 and changes nothing', async () => {
    const from = await app.createAccount('50.00');
    const to = await app.createAccount('0');

    const res = await transfer({ from_account_id: from, to_account_id: to, amount: '50.01' });

    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'insufficient_funds', message: 'Source account has insufficient funds' });
    assert.equal(await app.balance(from), '50.00');
    assert.equal(await app.balance(to), '0.00');
    assert.equal(await transferCount(from), 0);
  });

  test('an unknown destination returns 404 and leaves the source unchanged', async () => {
    const from = await app.createAccount('100.00');

    const res = await transfer({ from_account_id: from, to_account_id: MISSING_ID, amount: '10' });

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'account_not_found', message: 'Destination account not found' });
    assert.equal(await app.balance(from), '100.00');
    assert.equal(await transferCount(from), 0);
  });

  test('an unknown source returns 404 and credits nothing', async () => {
    const to = await app.createAccount('0');

    const res = await transfer({ from_account_id: MISSING_ID, to_account_id: to, amount: '10' });

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'account_not_found', message: 'Source account not found' });
    assert.equal(await app.balance(to), '0.00');
  });
});

describe('POST /transfers validation', () => {
  let from: string;
  let to: string;

  before(async () => {
    from = await app.createAccount('100.00');
    to = await app.createAccount('0');
  });

  async function expectRejected(body: unknown, status: number, error: string) {
    const res = await transfer(body);
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.equal(res.body.error, error);
    assert.equal(typeof res.body.message, 'string');
    // No validation failure may move money.
    assert.equal(await app.balance(from), '100.00');
    assert.equal(await app.balance(to), '0.00');
  }

  for (const field of ['from_account_id', 'to_account_id', 'amount'] as const) {
    test(`rejects a missing ${field}`, async () => {
      const body: Record<string, unknown> = { from_account_id: from, to_account_id: to, amount: '1' };
      delete body[field];
      await expectRejected(body, 400, 'missing_field');
    });
  }

  for (const [label, value] of [
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['negative', '-5'],
    ['three decimals', '1.005'],
    ['a JSON number', 5],
    ['letters', 'ten'],
    ['null', null],
  ] as const) {
    test(`rejects amount: ${label}`, async () => {
      await expectRejected({ from_account_id: from, to_account_id: to, amount: value }, 400, 'invalid_amount');
    });
  }

  test('rejects a malformed account id with 400, not 500', async () => {
    await expectRejected({ from_account_id: 'abc', to_account_id: to, amount: '1' }, 400, 'invalid_account_id');
    await expectRejected({ from_account_id: from, to_account_id: 42, amount: '1' }, 400, 'invalid_account_id');
  });

  test('rejects a transfer to the same account, even with different letter case', async () => {
    await expectRejected({ from_account_id: from, to_account_id: from, amount: '1' }, 400, 'same_account');
    await expectRejected({ from_account_id: from, to_account_id: from.toUpperCase(), amount: '1' }, 400, 'same_account');
  });

  test('rejects unknown fields', async () => {
    await expectRejected({ from_account_id: from, to_account_id: to, amount: '1', currency: 'USD' }, 400, 'unknown_field');
  });

  test('rejects malformed JSON', async () => {
    await expectRejected('{"amount": ', 400, 'malformed_json');
  });
});
