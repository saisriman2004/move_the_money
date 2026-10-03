import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;
let risk: typeof import('../src/risk.js');

before(async () => {
  Object.assign(process.env, {
    RISK_REVIEW_AMOUNT: '100.00',
    RISK_REJECT_AMOUNT: '1000.00',
    RISK_MAX_TRANSFERS_PER_MINUTE: '3',
    RISK_NEW_ACCOUNT_HOURS: '24',
    RISK_NEW_ACCOUNT_REVIEW_AMOUNT: '50.00',
    RISK_MAX_RECENT_REJECTIONS: '2',
  });
  app = await startTestApp();
  risk = await import('../src/risk.js');
});

after(async () => {
  await app.close();
});

const rules = { reviewAmount: '100.00', rejectAmount: '1000.00', maxTransfersPerMinute: 3, newAccountHours: 24, newAccountReviewAmount: '50.00', maxRecentRejections: 2 };
const facts = (over: Partial<import('../src/risk.js').RiskFacts> = {}) => ({
  amount: '10.00',
  transfersLastMinute: 0,
  accountAgeHours: 100,
  rejectionsLast10Minutes: 0,
  amountAtLeastReview: false,
  amountAtLeastReject: false,
  amountAtLeastNewAccountReview: false,
  ...over,
});

describe('risk rules (pure)', () => {
  test('approve when nothing fires', () => {
    assert.deepEqual(risk.assessRisk(facts(), rules), { decision: 'approve', reasons: [] });
  });

  for (const [label, over, expected] of [
    ['a large amount is reviewed', { amountAtLeastReview: true }, { decision: 'review', reasons: ['large_amount'] }],
    ['an amount over the limit is rejected', { amountAtLeastReview: true, amountAtLeastReject: true }, { decision: 'reject', reasons: ['amount_over_limit'] }],
    ['too many transfers in a minute is rejected', { transfersLastMinute: 3 }, { decision: 'reject', reasons: ['too_many_transfers'] }],
    ['repeated rejections are rejected', { rejectionsLast10Minutes: 2 }, { decision: 'reject', reasons: ['repeated_rejections'] }],
    ['a large transfer from a new account is reviewed', { accountAgeHours: 1, amountAtLeastNewAccountReview: true }, { decision: 'review', reasons: ['new_account_large_transfer'] }],
    ['the most severe rule wins and every reason is listed', { amountAtLeastReview: true, transfersLastMinute: 9 }, { decision: 'reject', reasons: ['large_amount', 'too_many_transfers'] }],
  ] as const) {
    test(label, () => {
      assert.deepEqual(risk.assessRisk(facts(over), rules), expected);
    });
  }
});

describe('risk checks on POST /transfers', () => {
  async function account(balance: string, ageDays = 0): Promise<string> {
    const id = await app.createAccount(balance);
    if (ageDays) await app.query(`UPDATE accounts SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [id, ageDays]);
    return id;
  }
  const send = (from: string, to: string, amount: string, key = randomUUID()) =>
    app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount }, { 'Idempotency-Key': key });

  async function decisions(from: string) {
    return app.query<{ decision: string; reasons: string[]; transfer_id: string | null }>(
      'SELECT decision, reasons, transfer_id FROM risk_decisions WHERE from_account_id = $1 ORDER BY created_at',
      [from],
    );
  }

  test('a normal transfer is approved and the decision is recorded with it', async () => {
    const a = await account('500.00', 5);
    const res = await send(a, await app.createEmptyAccount(), '10.00');
    assert.equal(res.status, 201);
    assert.equal(res.body.risk_decision, 'approve');
    assert.deepEqual(await decisions(a), [{ decision: 'approve', reasons: [], transfer_id: res.body.id }]);
  });

  test('a large transfer goes through but is flagged for review, with reasons', async () => {
    const a = await account('500.00');
    const res = await send(a, await app.createEmptyAccount(), '150.00');
    assert.equal(res.status, 201);
    assert.equal(res.body.risk_decision, 'review');
    assert.deepEqual((await decisions(a))[0]!.reasons, ['large_amount', 'new_account_large_transfer']);
  });

  test('an amount over the limit is declined with 422, moves nothing, and the rejection is kept', async () => {
    const a = await account('5000.00', 5);
    const b = await app.createEmptyAccount();
    const res = await send(a, b, '1000.00');
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'risk_rejected', message: 'Transfer declined by risk checks', reasons: ['amount_over_limit'] });
    assert.equal(await app.balance(a), '5000.00');
    assert.equal(await app.balance(b), '0.00');
    assert.deepEqual(await decisions(a), [{ decision: 'reject', reasons: ['amount_over_limit'], transfer_id: null }]);
  });

  test('the fourth transfer within a minute is declined', async () => {
    const a = await account('500.00', 5);
    const b = await app.createEmptyAccount();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await send(a, b, '1.00')).status);
    assert.deepEqual(statuses, [201, 201, 201, 422]);
  });

  test('10 concurrent transfers from one account against a limit of 3: exactly 3 go through', async () => {
    const a = await account('500.00', 5);
    const b = await app.createEmptyAccount();
    const results = await Promise.all(Array.from({ length: 10 }, () => send(a, b, '1.00')));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(await app.balance(b), '3.00');
  });

  test('after two rejections, even a small transfer is declined', async () => {
    const a = await account('5000.00', 5);
    const b = await app.createEmptyAccount();
    await send(a, b, '1000.00');
    await send(a, b, '2000.00');
    const small = await send(a, b, '1.00');
    assert.equal(small.status, 422);
    assert.deepEqual(small.body.reasons, ['repeated_rejections']);
  });

  test('replaying an approved transfer is not re-checked, even after the limit is hit', async () => {
    const a = await account('500.00', 5);
    const b = await app.createEmptyAccount();
    const key = randomUUID();
    const first = await send(a, b, '1.00', key);
    await send(a, b, '1.00');
    await send(a, b, '1.00');
    assert.equal((await send(a, b, '1.00')).status, 422);
    const replay = await send(a, b, '1.00', key);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
  });

  test('refunds are not subject to risk checks', async () => {
    const payer = await app.registerUser();
    const payerAccount = (await app.request('POST', '/accounts', { first_name: 'P', last_name: 'R', starting_balance: '500.00' }, { authorization: `Bearer ${payer.token}` })).body.id;
    const mine = await account('1.00', 5);
    const paid = await app.request('POST', '/transfers', { from_account_id: payerAccount, to_account_id: mine, amount: '20.00' }, { authorization: `Bearer ${payer.token}`, 'Idempotency-Key': randomUUID() });
    // Use up my own transfer allowance first.
    const sink = await app.createEmptyAccount();
    for (let i = 0; i < 3; i++) await send(mine, sink, '0.01');
    const refund = await app.request('POST', `/transfers/${paid.body.id}/refund`, undefined, { 'Idempotency-Key': randomUUID() });
    assert.equal(refund.status, 201);
  });
});
