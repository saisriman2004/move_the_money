import type { PoolClient } from 'pg';

/** Platform-owned accounts, created by migration 004. */
export const SYSTEM_ACCOUNTS = {
  /** Where money enters the system. Goes negative by the total ever deposited. */
  funding: '00000000-0000-4000-8000-000000000001',
  /** Collects transfer fees. */
  fees: '00000000-0000-4000-8000-000000000002',
} as const;

export interface LedgerLine {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: string;
}

/**
 * Writes a transfer's ledger entries. Must run in the same transaction as the
 * balance updates; the database rejects the commit if debits and credits differ.
 */
export async function postLedgerEntries(client: PoolClient, transferId: string, lines: LedgerLine[]): Promise<void> {
  const values: unknown[] = [];
  const rows = lines.map((line, i) => {
    values.push(line.accountId, line.direction, line.amount);
    return `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`;
  });
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ${rows.join(', ')}`,
    [transferId, ...values],
  );
}
