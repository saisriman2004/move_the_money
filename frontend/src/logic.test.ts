import { describe, expect, test } from 'vitest';
import type { HistoryItem } from './api';
import { describe as describeItem, filterHistory } from './history';
import { PaymentAttempt } from './idempotency';
import { validateAmount } from './money';

describe('validateAmount', () => {
  test.each(['25', '25.5', '25.50', '0.01', '999999999999999999.99'])('accepts %s', (v) => expect(validateAmount(v)).toBeNull());
  test.each(['', 'abc', '-5', '1.005', '1e3', '1,000', '.5', '1000000000000000000'])('rejects %s', (v) => expect(validateAmount(v)).not.toBeNull());
  test('rejects zero with its own message', () => expect(validateAmount('0.00')).toBe('Amount must be greater than zero'));
});

describe('PaymentAttempt', () => {
  let n = 0;
  const attempt = () => new PaymentAttempt(() => `key-${++n}`);

  test('reuses the key while the outcome is uncertain, so a retry cannot pay twice', () => {
    const a = attempt();
    const first = a.keyForSubmit();
    a.settle('uncertain');
    expect(a.keyForSubmit()).toBe(first);
  });

  test('a definite answer finishes the payment; the next one gets a new key', () => {
    const a = attempt();
    const first = a.keyForSubmit();
    a.settle('definite');
    expect(a.keyForSubmit()).not.toBe(first);
  });

  test('editing the form after a failure starts a new payment', () => {
    const a = attempt();
    const first = a.keyForSubmit();
    a.settle('uncertain');
    a.reset();
    expect(a.keyForSubmit()).not.toBe(first);
  });
});

describe('history filters', () => {
  const item = (kind: HistoryItem['kind'], direction: HistoryItem['direction']): HistoryItem => ({
    id: `${kind}-${direction}`, kind, direction, from_account_id: 'a', to_account_id: 'b', amount: '1.00', fee: '0.00', refund_of: null, risk_decision: null, created_at: '',
  });
  const items = [item('transfer', 'debit'), item('transfer', 'credit'), item('refund', 'credit'), item('deposit', 'credit')];

  test('sent, received and refunds', () => {
    expect(filterHistory(items, 'sent').map((t) => t.id)).toEqual(['transfer-debit']);
    expect(filterHistory(items, 'received').map((t) => t.id)).toEqual(['transfer-credit', 'deposit-credit']);
    expect(filterHistory(items, 'refunds').map((t) => t.id)).toEqual(['refund-credit']);
    expect(filterHistory(items, 'all')).toHaveLength(4);
  });

  test('labels', () => {
    expect(items.map(describeItem)).toEqual(['Sent', 'Received', 'Refund received', 'Opening deposit']);
  });
});
