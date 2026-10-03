# 12. Ledger reconciliation

**What.** `reconcile()` audits the books and stores each run in `reconciliation_runs`. Run it once with `npm run reconcile` (prints the report, exits 1 on a mismatch, so it fits cron or CI) or continuously with `npm run worker:reconciliation` (hourly by default). The five checks:
1. **balance_mismatch:** an account's balance differs from its ledger-derived balance.
2. **unbalanced_transfer:** a transfer's debits differ from its credits.
3. **entries_do_not_match_amount:** a transfer's entries don't move exactly its amount plus fee.
4. **missing_ledger_entries:** a transfer has no entries.
5. **total_not_zero:** all balances, system accounts included, don't sum to zero (money was created or destroyed).

**Why.** The database already blocks most corruption (immutable entries, balanced commits). Reconciliation catches what slips through anyway: manual SQL fixes, bugs that bypass the ledger, restores from a bad backup, or a trigger someone disabled. It answers "how would you know if your financial data were wrong?"

**How.**
- Every check is a single SQL statement over the `account_ledger_balances` view and the ledger, comparing money in SQL.
- All checks share one `REPEATABLE READ`, read-only transaction (a new option on `withTransaction`), so the counts and issues in a report describe the same moment.
- A mismatch is logged at error level with the first issues: the hook for alerting.

**Decisions and a correction.**
- I first claimed the REPEATABLE READ snapshot is what stops transfers committing mid-run from causing false alarms. A mutation test disproved that: with the snapshot removed, the concurrency test still passed. The real reason is that each check is one statement, and PostgreSQL gives every statement a consistent snapshot even at READ COMMITTED. The shared snapshot makes the report coherent as a whole, which is still useful, but it isn't the false-alarm guard. The code comment now says so, and warns that splitting a check across queries would break it.
- Full scans each run. At larger scale this becomes incremental: checkpoint balances and only audit entries written since.
- No admin API for reports yet; they're in the table and the logs.

**What can fail.** A full audit on a very large ledger is slow and holds a long read transaction. Reconciliation finds problems; it doesn't fix them. Fixes should be compensating transfers, never edits.

**How it was tested.** 6 tests in `test/reconciliation.test.ts` (own database, 1% fees on): a ledger built only through the API (deposits, fees, a transfer and a refund) reconciles; a balance edited with plain SQL produces `balance_mismatch` with both values and `total_not_zero` of exactly 10.00, then reconciles again once reverted; an extra credit inserted with triggers disabled is caught as `unbalanced_transfer` and as a balance mismatch; a transfer amount edited behind the ledger's back is caught (`6.05` expected, `5.05` debited); a transfer row with no entries is caught; 8 reconciliation runs during 60 concurrent transfers report no false mismatches. It was also run against the real development database: 53 accounts and 66 transfers, all reconciled.
