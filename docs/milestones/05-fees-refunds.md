# 5. Transfer fees and compensating refunds

**What.**
- A configurable percentage fee (`TRANSFER_FEE_PERCENT`, default 0; `.env.example` sets 1). The sender pays amount plus fee; the receiver gets the amount; the platform's `fees` account gets the fee.
- `POST /transfers/:id/refund`: the receiver refunds a transfer in full with a new `refund` transfer that points back at the original with `refund_of`.

**Why.** Fees show a transfer that touches three accounts and still balances. Refunds show the core rule of financial records: history is never edited. A mistake or a return is corrected by a new, compensating entry, so the original stays auditable.

**How.**
- The fee is computed in SQL (`round(amount * percent / 100, 2)`), so money never becomes a JavaScript number. The guarded debit checks the balance covers amount plus fee in the same statement.
- A transfer with a fee writes four ledger entries: debit sender / credit receiver for the amount, debit sender / credit fees for the fee.
- A refund locks the original transfer row (`FOR UPDATE OF t`) before checking for an existing refund, so two concurrent refunds of the same transfer serialize: one succeeds, the other gets `409 already_refunded`. A `UNIQUE (refund_of)` constraint backs this up.
- Idempotency is shared with transfers: the key is claimed first, and a replay with a matching refund returns the original refund.

**Decisions.**
- **Only the receiver can refund**, like a merchant refunding a customer. The sender gets 403 (they can already see the transfer, so 403 leaks nothing); anyone else gets 404.
- **Full refunds only, once per transfer, fee not refunded.** Partial refunds would need tracking of the remaining refundable amount; out of scope.
- **The fees account is a hot row.** Every fee-paying transfer updates it, so those transfers briefly queue on its lock. It is always locked after the customer accounts, so lock order stays consistent and no deadlock is possible. At high volume the standard fixes are several fee accounts (sharding) or crediting fees in a periodic sweep.
- **The 409 message is now generic** ("used for a different request") because refunds share the idempotency logic.

**What can fail.**
- A receiver who already spent the money can't refund (422), which is correct: money isn't created.
- Fees round to the cent, so a 0.10 transfer at 1% pays no fee.

**How it was tested.** 15 tests in `test/fees-refunds.test.ts` (the file sets `TRANSFER_FEE_PERCENT=1`): balances and fees for a 100.00 transfer, the four fee ledger entries, rounding for four amounts, balance must cover amount plus fee, 10 concurrent fee-paying transfers credit the fees account exactly 1.00, refund balances with the original untouched, replay and `already_refunded`, 5 rounds of concurrent refunds (exactly one succeeds), 403 for the sender and 404 for a stranger, refunds and deposits not refundable, insufficient funds, and request validation. Mutation checks: not crediting the fees account fails 2 tests; removing the lock on the original fails the concurrent-refund test; removing the already-refunded check fails 2; letting the sender refund fails 1.
