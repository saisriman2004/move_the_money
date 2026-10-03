import { pool, withTransaction } from './db';
import { logger } from './logger';
import { reconciliationIssues, reconciliationLastRun } from './metrics';

export type ReconciliationIssue =
  | { type: 'balance_mismatch'; account_id: string; balance: string; ledger_balance: string }
  | { type: 'unbalanced_transfer'; transfer_id: string; debits: string; credits: string }
  | { type: 'entries_do_not_match_amount'; transfer_id: string; amount_plus_fee: string; debits: string }
  | { type: 'missing_ledger_entries'; transfer_id: string }
  | { type: 'total_not_zero'; total: string };

export interface ReconciliationReport {
  id: string;
  status: 'reconciled' | 'mismatch';
  started_at: Date;
  finished_at: Date;
  accounts_checked: number;
  transfers_checked: number;
  issues: ReconciliationIssue[];
}

/**
 * Audits the books. Each check is a single SQL statement, and PostgreSQL runs every
 * statement against a consistent snapshot, so a transfer committing mid-run can't
 * make a check see half of it. The checks also share one REPEATABLE READ, read-only
 * transaction, so the whole report (counts included) describes a single moment.
 * Keep each check to one statement: splitting one across queries would break this.
 * Money is only compared in SQL.
 */
export async function reconcile(): Promise<ReconciliationReport> {
  const startedAt = new Date();
  const result = await withTransaction(
    async (client) => {
      const issues: ReconciliationIssue[] = [];

      // 1. Every balance equals the balance rebuilt from the ledger.
      const balances = await client.query<{ account_id: string; balance: string; ledger_balance: string }>(
        `SELECT account_id, balance::text, ledger_balance::text FROM account_ledger_balances
          WHERE balance <> ledger_balance ORDER BY account_id`,
      );
      for (const row of balances.rows) issues.push({ type: 'balance_mismatch', ...row });

      // 2. Every transfer's debits equal its credits.
      const unbalanced = await client.query<{ transfer_id: string; debits: string; credits: string }>(
        `SELECT transfer_id,
                sum(amount) FILTER (WHERE direction = 'debit')::text AS debits,
                sum(amount) FILTER (WHERE direction = 'credit')::text AS credits
           FROM ledger_entries GROUP BY transfer_id
         HAVING coalesce(sum(amount) FILTER (WHERE direction = 'debit'), 0)
             <> coalesce(sum(amount) FILTER (WHERE direction = 'credit'), 0)`,
      );
      for (const row of unbalanced.rows) {
        issues.push({ type: 'unbalanced_transfer', transfer_id: row.transfer_id, debits: row.debits ?? '0', credits: row.credits ?? '0' });
      }

      // 3. A transfer's entries move exactly its amount plus fee; 4. no transfer lacks entries.
      const transfers = await client.query<{ transfer_id: string; amount_plus_fee: string; debits: string | null }>(
        `SELECT t.id AS transfer_id, (t.amount + t.fee)::text AS amount_plus_fee, d.debits::text AS debits
           FROM transfers t
           LEFT JOIN (SELECT transfer_id, sum(amount) AS debits FROM ledger_entries
                       WHERE direction = 'debit' GROUP BY transfer_id) d ON d.transfer_id = t.id
          WHERE d.debits IS DISTINCT FROM t.amount + t.fee`,
      );
      for (const row of transfers.rows) {
        if (row.debits === null) issues.push({ type: 'missing_ledger_entries', transfer_id: row.transfer_id });
        else issues.push({ type: 'entries_do_not_match_amount', transfer_id: row.transfer_id, amount_plus_fee: row.amount_plus_fee, debits: row.debits });
      }

      // 5. Money is only moved, never created: all balances, system accounts included, sum to zero.
      const total = await client.query<{ total: string; zero: boolean }>(
        'SELECT coalesce(sum(balance), 0)::text AS total, coalesce(sum(balance), 0) = 0 AS zero FROM accounts',
      );
      if (!total.rows[0]!.zero) issues.push({ type: 'total_not_zero', total: total.rows[0]!.total });

      const counts = await client.query<{ accounts: number; transfers: number }>(
        'SELECT (SELECT count(*)::int FROM accounts) AS accounts, (SELECT count(*)::int FROM transfers) AS transfers',
      );
      return { issues, ...counts.rows[0]! };
    },
    { isolation: 'repeatable read', readOnly: true },
  );

  const status = result.issues.length === 0 ? 'reconciled' : 'mismatch';
  const { rows } = await pool.query<ReconciliationReport>(
    `INSERT INTO reconciliation_runs (started_at, finished_at, status, accounts_checked, transfers_checked, issues)
     VALUES ($1, now(), $2, $3, $4, $5) RETURNING *`,
    [startedAt, status, result.accounts, result.transfers, JSON.stringify(result.issues)],
  );
  const report = rows[0]!;
  reconciliationIssues.set(result.issues.length);
  reconciliationLastRun.set(Date.now() / 1000);
  const summary = { run_id: report.id, accounts_checked: report.accounts_checked, transfers_checked: report.transfers_checked, issues: result.issues.length };
  if (status === 'mismatch') {
    // The alert: an error-level log line that monitoring can page on.
    logger.error('reconciliation mismatch', { ...summary, first_issues: result.issues.slice(0, 5) });
  } else {
    logger.info('reconciliation passed', summary);
  }
  return report;
}
