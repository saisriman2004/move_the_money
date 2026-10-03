# Financial integrity

The guarantees the system makes about money, how each one is enforced, and the evidence that it holds. Wherever possible a rule is enforced twice: once by the application, and once by PostgreSQL itself, so a bug in one layer is caught by the other.

## The guarantees

| Guarantee | Enforced by | Evidence |
|---|---|---|
| **No customer balance goes negative** | Guarded debit `UPDATE … WHERE balance >= amount + fee`; row locks; `CHECK (kind = 'system' OR balance >= 0)` | `concurrency.test.ts`: two concurrent 80.00 transfers from 100.00, exactly one succeeds, 5 rounds |
| **Money is never created or lost** | Every movement is one transaction; balanced ledger entries; funding account mirrors every deposit | All balances sum to exactly 0.00; reconciliation after 15,559 load-test transfers found 0 issues |
| **Every movement is recorded and can't be altered** | `ledger_entries` trigger rejects `UPDATE`/`DELETE`; corrections are new compensating transfers | `ledger.test.ts`: edits refused; refunds leave the original untouched |
| **Every transfer balances** | Deferred constraint trigger checks debits = credits at `COMMIT` | `ledger.test.ts`: an unbalanced write is rejected at commit |
| **Balances can be rebuilt from the ledger** | `account_ledger_balances` view; reconciliation compares | `ledger.test.ts`, `reconciliation.test.ts` |
| **The same transfer submitted twice is applied once** | Required `Idempotency-Key`, unique per user; advisory lock taken first in the transaction | `idempotency.test.ts`: 20 concurrent requests with one key → one transfer; a missing key is refused |
| **Amounts are exact** | `NUMERIC` in the database; strings in the API and browser; all arithmetic and comparisons in SQL | 10 × 0.10 = 1.00 exactly; 18-digit amounts exact; JSON numbers rejected |
| **Only the owner moves money out** | Ownership checked on the locked source row | `auth.test.ts`: transfers out of someone else's account → 404, balance unchanged |
| **An event exists if and only if its money moved** | Transactional outbox | `outbox.test.ts`: rejected transfers and rolled-back transactions leave no event |

## How money is represented

- **Database:** `NUMERIC(20,2)` for amounts (at most 18 integer digits) and `NUMERIC(38,2)` for balances, which accumulate many amounts. The funding account holds the negated total of all deposits.
- **API:** JSON strings matching `^\d{1,18}(\.\d{1,2})?$`. A JSON number is rejected, because it may have been rounded by the client's or the server's JSON parser before validation (`0.1 + 0.2` is `0.30000000000000004`).
- **Application:** money values are never converted to JavaScript numbers. Fees (`round(amount × percent / 100, 2)`), balance checks and equality (`"100"` = `"100.00"`) are computed in SQL.
- **Browser:** the same pattern validates input; values are displayed exactly as returned and never added up.

## The ledger

Every movement is a row in `transfers` and two or more rows in `ledger_entries`:

| Movement | Entries |
|---|---|
| Opening an account with 100.00 | debit `funding` 100.00 · credit account 100.00 |
| Transfer of 100.00 with a 1.00 fee | debit sender 100.00 · credit receiver 100.00 · debit sender 1.00 · credit `fees` 1.00 |
| Refund of that transfer | debit receiver 100.00 · credit sender 100.00 (fees are not refunded) |

`accounts.balance` is the running total that gets locked and read; the ledger is the record it must always agree with. Because opening balances come from the `funding` system account (which may go negative), the sum of **all** balances, system accounts included, is always exactly zero. Any other total means money was created or destroyed.

Data from before the ledger existed was backfilled by migration 004: each old transfer got its entries, and each unexplained balance became an `adjustment` from `funding`. The migration was dry-run against a copy of a real development database first; afterwards every account reconciled.

## Concurrency

Every transfer and refund locks the accounts it touches with `SELECT … ORDER BY id FOR UPDATE`. A second transfer touching either account waits, then sees the committed balance. Locking in id order means two transfers between the same accounts in opposite directions always lock in the same order and can't deadlock.

| Lock strategy, 100 concurrent A↔B transfers | Deadlocks |
|---|---|
| source first, then destination | 85 |
| no `ORDER BY` | 21 and 1 in two runs (intermittent) |
| `ORDER BY id` | 0 |

The balance check is inside the debit statement, so there's no gap between checking and acting. Risk velocity checks run after the source row is locked, so concurrent transfers from one account can't all slip under a per-minute limit. Removing that ordering let more than 3 of 10 concurrent transfers through a limit of 3.

## Idempotency

The client sends an `Idempotency-Key` with every transfer and refund: a new key per intended payment, and the same key on retries. The first statement of the transaction is `pg_advisory_xact_lock(hash(user_id:key))`, so requests sharing a key run one after another; the later one finds the earlier one's result:

- same key and same request → the original response, with `Idempotent-Replayed: true`, and no money moves;
- same key and a different request → `409 idempotency_key_conflict`;
- a key whose first attempt failed (for example `422`) is free to use again.

The lock is taken *before* the balance check on purpose. If the uniqueness of the key were only enforced at insert time, a retry of a transfer that spends the whole balance would fail with `insufficient_funds` before ever reaching the insert, and the client would get a 422 for a payment that succeeded. The account row locks alone aren't enough either: they don't serialize the same key used on different accounts, which would surface as a unique-violation 500 instead of a 409. A test covers exactly that case.

Consumers are idempotent the same way: each records `(consumer, event_id)` in the same transaction as its own writes. Webhook deliveries and notifications are additionally unique per (endpoint or user, event).

## Corrections and refunds

History is never edited. A refund is a new `refund` transfer in the opposite direction with `refund_of` pointing at the original; the original stays exactly as it was. A transfer can be refunded once (the original row is locked during the refund, backed by a `UNIQUE (refund_of)` constraint), only by the receiver, and only if the receiver still holds the money.

## Detecting what slipped through

Reconciliation (`npm run reconcile`, or hourly via the worker) checks, from one consistent snapshot, that every balance equals its ledger balance, every transfer balances, every transfer's entries match its amount plus fee, no transfer lacks entries, and all balances sum to zero. Each run is stored with its issues; a mismatch is logged at error level and exposed as the `reconciliation_issues` metric. Tests inject each kind of corruption, bypassing the application and the database triggers, and check that it's reported.
