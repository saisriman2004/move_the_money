import type { HistoryItem } from './api';

export type HistoryFilter = 'all' | 'sent' | 'received' | 'refunds';

/** Client-side filters over an account's history (newest first, as the API returns it). */
export function filterHistory(items: HistoryItem[], filter: HistoryFilter): HistoryItem[] {
  switch (filter) {
    case 'sent':
      return items.filter((t) => t.direction === 'debit' && t.kind !== 'refund');
    case 'received':
      return items.filter((t) => t.direction === 'credit' && t.kind !== 'refund');
    case 'refunds':
      return items.filter((t) => t.kind === 'refund');
    default:
      return items;
  }
}

/** How a history row reads from this account's side. */
export function describe(t: HistoryItem): string {
  if (t.kind === 'deposit') return 'Opening deposit';
  if (t.kind === 'adjustment') return 'Ledger adjustment';
  if (t.kind === 'refund') return t.direction === 'credit' ? 'Refund received' : 'Refund sent';
  return t.direction === 'credit' ? 'Received' : 'Sent';
}
