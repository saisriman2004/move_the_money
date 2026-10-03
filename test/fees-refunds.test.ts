import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, startTestApp, type TestApp, type TestUser } from './helpers';

const FEES = '00000000-0000-4000-8000-000000000002';

let app: TestApp;

before(async () => {
  // Read when the app is imported, so set before starting it. This file runs in its own process.
  process.env.TRANSFER_FEE_PERCENT = '1';
  app = await startTestApp();
});

after(async () => {
  await app?.close();
});

function transfer(from: string, to: string, amount: string, key = randomUUID()) {
  return app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount }, { 'Idempotency-Key': key });
}

function refund(transferId: string, user?: TestUser, key = randomUUID()) {
  const auth: Record<string, string> = user ? { authorization: `Bearer ${user.token}` } : {};
  return app.request('POST', `/transfers/${transferId}/refund`, undefined, { ...auth, 'Idempotency-Key': key });
}

async function feesBalance(): Promise<string> {
  const [row] = await app.query<{ balance: string }>('SELECT balance::text FROM accounts WHERE id = $1', [FEES]);
  return row!.balance;
}

/** Fee-account balance changes by exactly `delta`, compared in SQL to avoid floats. */
async function assertFeesMoved(before: string, delta: string) {
  const [row] = await app.query<{ ok: boolean }>('SELECT $1::numeric + $2::numeric = $3::numeric AS ok', [before, delta, await feesBalance()]);
  assert.ok(row!.ok, `fees account should move by ${delta}`);
}

async function ledgerMatches(accountId: string) {
  const [row] = await app.query<{ balance: string; ledger_balance: string }>(
    'SELECT balance::text, ledger_balance::text FROM account_ledger_balances WHERE account_id = $1',
    [accountId],
  );
  assert.equal(row!.ledger_balance, row!.balance);
}

describe('transfer fees', () => {
  test('the sender pays amount + 1%, the receiver gets the amount, the fees account gets the fee', async () => {
    const a = await app.createAccount('200.00');
    const b = await app.createEmptyAccount();
    const feesBefore = await feesBalance();

    const res = await transfer(a, b, '100.00');

    assert.equal(res.status, 201);
    assert.equal(res.body.amount, '100.00');
    assert.equal(res.body.fee, '1.00');
    assert.equal(await app.balance(a), '99.00');
    assert.equal(await app.balance(b), '100.00');
    await assertFeesMoved(feesBefore, '1.00');
    await ledgerMatches(a);
    await ledgerMatches(b);
  });

  test('the fee is a separate, balanced pair of ledger entries', async () => {
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount();
    const { id } = (await transfer(a, b, '20.00')).body;
    const entries = (await app.request('GET', `/transfers/${id}`)).body.ledger_entries;
    const lines = entries.map((e: { account_id: string; direction: string; amount: string }) => `${e.direction} ${e.account_id === FEES ? 'fees' : e.account_id === a ? 'sender' : 'receiver'} ${e.amount}`);
    assert.deepEqual(lines.sort(), ['credit fees 0.20', 'credit receiver 20.00', 'debit sender 0.20', 'debit sender 20.00']);
  });

  for (const [amount, fee] of [['0.10', '0.00'], ['0.50', '0.01'], ['12.34', '0.12'], ['999.99', '10.00']] as const) {
    test(`a ${amount} transfer is charged ${fee}, rounded to the cent`, async () => {
      const a = await app.createAccount('2000.00');
      const b = await app.createEmptyAccount();
      assert.equal((await transfer(a, b, amount)).body.fee, fee);
    });
  }

  test('the balance must cover the amount plus the fee', async () => {
    const a = await app.createAccount('100.00');
    const b = await app.createEmptyAccount();
    const tooMuch = await transfer(a, b, '100.00'); // needs 101.00
    assert.equal(tooMuch.status, 422);
    assert.equal(await app.balance(a), '100.00');
    const fits = await transfer(a, b, '99.00'); // needs 99.99
    assert.equal(fits.status, 201);
    assert.equal(await app.balance(a), '0.01');
  });

  test('concurrent transfers all credit the fees account exactly once each', async () => {
    const senders = await Promise.all(Array.from({ length: 10 }, () => app.createAccount('100.00')));
    const receiver = await app.createEmptyAccount();
    const feesBefore = await feesBalance();
    const results = await Promise.all(senders.map((s) => transfer(s, receiver, '10.00')));
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(201));
    await assertFeesMoved(feesBefore, '1.00'); // 10 x 0.10
    assert.equal(await app.balance(receiver), '100.00');
  });
});

describe('refunds', () => {
  let sender: TestUser;
  let receiver: TestUser;
  let senderAccount: string;
  let receiverAccount: string;

  before(async () => {
    sender = await app.registerUser();
    receiver = await app.registerUser();
    const open = async (user: TestUser, balance: string) =>
      (await app.request('POST', '/accounts', { first_name: 'R', last_name: 'T', starting_balance: balance }, { authorization: `Bearer ${user.token}` })).body.id;
    senderAccount = await open(sender, '500.00');
    receiverAccount = await open(receiver, '1.00');
  });

  async function pay(amount: string): Promise<string> {
    const res = await app.request(
      'POST',
      '/transfers',
      { from_account_id: senderAccount, to_account_id: receiverAccount, amount },
      { authorization: `Bearer ${sender.token}`, 'Idempotency-Key': randomUUID() },
    );
    assert.equal(res.status, 201);
    return res.body.id;
  }

  test('the receiver refunds the amount with a new transfer; the original is untouched and the fee is kept', async () => {
    const original = await pay('100.00'); // sender pays 101.00
    const senderBefore = await app.balance(senderAccount);
    const receiverBefore = await app.balance(receiverAccount);
    const feesBefore = await feesBalance();

    const res = await refund(original, receiver);

    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'refund');
    assert.equal(res.body.refund_of, original);
    assert.equal(res.body.from_account_id, receiverAccount);
    assert.equal(res.body.to_account_id, senderAccount);
    assert.equal(res.body.amount, '100.00');
    assert.equal(res.body.fee, '0.00');

    const [moved] = await app.query<{ sender: boolean; receiver: boolean }>(
      'SELECT $1::numeric + 100 = $2::numeric AS sender, $3::numeric - 100 = $4::numeric AS receiver',
      [senderBefore, await app.balance(senderAccount), receiverBefore, await app.balance(receiverAccount)],
    );
    assert.ok(moved!.sender && moved!.receiver);
    await assertFeesMoved(feesBefore, '0');

    const detail = (await app.request('GET', `/transfers/${original}`, undefined, { authorization: `Bearer ${sender.token}` })).body;
    assert.equal(detail.kind, 'transfer');
    assert.equal(detail.amount, '100.00');
    assert.equal(detail.refunded_by, res.body.id);
    await ledgerMatches(senderAccount);
    await ledgerMatches(receiverAccount);
  });

  test('retrying a refund with the same key replays it; a new key gets 409 already_refunded', async () => {
    const original = await pay('5.00');
    const key = randomUUID();
    const first = await refund(original, receiver, key);
    const replay = await refund(original, receiver, key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(replay.body.id, first.body.id);

    const again = await refund(original, receiver);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already_refunded');
  });

  test('two concurrent refunds of one transfer with different keys: exactly one succeeds', async () => {
    for (let round = 0; round < 5; round++) {
      const original = await pay('3.00');
      const results = await Promise.all([refund(original, receiver), refund(original, receiver)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], `round ${round}`);
      const [count] = await app.query<{ n: string }>('SELECT count(*) AS n FROM transfers WHERE refund_of = $1', [original]);
      assert.equal(count!.n, '1');
    }
  });

  test('the sender cannot refund (403), a stranger sees nothing (404)', async () => {
    const original = await pay('2.00');
    const bySender = await refund(original, sender);
    assert.equal(bySender.status, 403);
    assert.equal(bySender.body.error, 'refund_not_allowed');
    const stranger = await app.registerUser();
    assert.equal((await refund(original, stranger)).status, 404);
  });

  test('refunds and deposits cannot themselves be refunded', async () => {
    const original = await pay('2.00');
    const r = (await refund(original, receiver)).body;
    const refundOfRefund = await refund(r.id, sender);
    assert.equal(refundOfRefund.status, 422);
    assert.equal(refundOfRefund.body.error, 'not_refundable');

    const [deposit] = await app.query<{ id: string }>("SELECT id FROM transfers WHERE kind = 'deposit' AND to_account_id = $1", [receiverAccount]);
    assert.equal((await refund(deposit!.id, receiver)).body.error, 'not_refundable');
  });

  test('a refund the receiver can no longer cover is rejected and changes nothing', async () => {
    const spender = await app.registerUser();
    const spenderAccount = (await app.request('POST', '/accounts', { first_name: 'S', last_name: 'P', starting_balance: '0.01' }, { authorization: `Bearer ${spender.token}` })).body.id;
    const original = (await app.request(
      'POST',
      '/transfers',
      { from_account_id: senderAccount, to_account_id: spenderAccount, amount: '50.00' },
      { authorization: `Bearer ${sender.token}`, 'Idempotency-Key': randomUUID() },
    )).body.id;
    // The receiver spends almost everything.
    await app.request(
      'POST',
      '/transfers',
      { from_account_id: spenderAccount, to_account_id: senderAccount, amount: '40.00' },
      { authorization: `Bearer ${spender.token}`, 'Idempotency-Key': randomUUID() },
    );
    const before = await app.balance(spenderAccount);
    const res = await refund(original, spender);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'insufficient_funds');
    assert.equal(await app.balance(spenderAccount), before);
  });

  test('a refund needs an Idempotency-Key, a valid id, and no body', async () => {
    assert.equal((await app.request('POST', `/transfers/${MISSING_ID}/refund`)).body.error, 'missing_idempotency_key');
    assert.equal((await refund('nope')).status, 400);
    assert.equal((await refund(MISSING_ID)).status, 404);
    const withBody = await app.request('POST', `/transfers/${MISSING_ID}/refund`, { amount: '1.00' }, { 'Idempotency-Key': randomUUID() });
    assert.equal(withBody.body.error, 'unknown_field');
  });
});
