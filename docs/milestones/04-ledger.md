# 4. Double-entry ledger

**What.** A `ledger_entries` table. Every movement of money is a transfer with balanced entries: a debit on the account money leaves and a credit on the account it reaches. Opening balances are now real `deposit` transfers from a platform-owned `funding` account. `GET /transfers/:id` returns a transfer with its entries.

**Why.** A balance column alone says how much an account has, but not why. The ledger records every movement, can't be edited, and lets every balance be rebuilt and checked (the reconciliation milestone builds on this).

**How.**
- `postLedgerEntries()` writes the entries in the same transaction as the balance updates.
- Two system accounts, `funding` and `fees`, have fixed ids. Funding is allowed to go negative (`CHECK (kind = 'system' OR balance >= 0)`), so the sum of all balances is always zero.
- The database enforces two invariants itself: a trigger rejects any `UPDATE`/`DELETE` on ledger entries, and a deferred constraint trigger checks at `COMMIT` that each transfer's debits equal its credits.
- The `account_ledger_balances` view rebuilds each balance from the ledger.
- Customers can't send ordinary transfers to system accounts (404).

**Decisions.**
- **Keep `accounts.balance`.** It's the row that gets locked and the fast read path. The ledger is the source of truth it must always agree with. The alternative, deriving every balance on read, makes locking and reads much harder.
- **Opening balances come from `funding`**, not from nowhere, so every cent's origin is in the ledger.
- **Balances widened to `NUMERIC(38,2)`.** The migration first failed with "numeric field overflow" on the test database: the funding account holds the negated sum of all deposits, which exceeds 18 digits. This also fixed a latent V1 bug where an account at the 18-digit maximum couldn't receive one more transfer. Single amounts stay capped at 18 digits.
- **Backfill in the migration.** Pre-ledger transfers got their entries; any balance the transfers don't explain became an `adjustment` from funding, dated when the account opened.

**What can fail.**
- Opening an account updates the single funding row, so account openings are serialized on it. Fine at this scale; at high volume the fix is to stop tracking a running balance on funding, or to shard it.
- Test fixtures that write directly with SQL (for example, topping up a balance with `UPDATE`) bypass the ledger. Reconciliation will report those accounts, which is the point of reconciliation.

**How it was tested.** 11 new tests in `test/ledger.test.ts`: the deposit's entries, a transfer's two entries, balances rebuilt from the ledger after a run of transfers, no unbalanced transfer anywhere in the database, no entries for a rejected transfer, updates and deletes refused, an unbalanced transfer refused at commit, system accounts hidden and unable to receive transfers, funding negative but customers not, and `GET /transfers/:id` for both parties, strangers, unknown and malformed ids. Mutation checks: skipping `postLedgerEntries` fails 3 tests; letting system accounts receive transfers fails 1. The migration was dry-run on a copy of the real dev database (50 accounts, 19 transfers): every account reconciled and all balances summed to 0.00.
