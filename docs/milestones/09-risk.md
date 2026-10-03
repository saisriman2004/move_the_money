# 9. Risk evaluation

**What.** A rule engine assesses every transfer before money moves:
- `approve`
- `review`: the transfer goes through but is flagged (`risk_decision: "review"`)
- `reject`: `422 risk_rejected` with `reasons`, and nothing moves

The rules, all configurable: amount at or above a review threshold (1,000.00) or reject threshold (10,000.00); more than 10 transfers per minute from one account; at least 500.00 from an account under 24 hours old; 3 or more rejections in the last 10 minutes. Every decision is stored in `risk_decisions`.

**Why.** Payment systems check transfers before authorising them. The point here is the architecture, not the model: where the check runs, what it can see, and how its decisions are recorded.

**How.**
- `assessRisk(facts)` is a pure function: each rule can raise the decision, and the most severe wins. Easy to read and unit test.
- `gatherRiskFacts()` reads everything the rules need in one SQL query, with amount comparisons done in SQL.
- The check runs inside the transfer's transaction, **after the source account is locked**. Concurrent transfers from the same account queue on that lock, so the per-minute count is always current.
- A rejection throws `RiskRejection`. The transaction rolls back, and the rejection is then recorded on its own connection so it survives (it feeds the repeated-rejections rule).
- Idempotent replays return the original result without re-checking; refunds return money and aren't checked.

**Decisions.**
- **A synchronous module, not a separate service.** The decision gates the money movement, so it has to be made before commit. A network hop would add latency and a new failure mode (what if the risk service is down?) for no benefit here. Analysis that doesn't gate transfers belongs in an asynchronous consumer of `transfer.completed`.
- **Review allows the transfer.** A real system might hold the funds pending a decision; that needs a pending state and an approval flow, out of scope.

**What can fail.** The rules are naive and easy to game (for example, staying just under thresholds). The structure is the deliverable: facts, rules, decisions, audit trail.

**How it was tested.** 15 tests in `test/risk.test.ts` with strict thresholds: each rule as a pure function, including the most severe winning; approve recorded with its transfer; review allowed and flagged with both reasons; reject returns 422, moves nothing and keeps the record; the fourth transfer in a minute declined; 10 concurrent transfers against a limit of 3 letting exactly 3 through; repeated rejections blocking small transfers; replays not re-checked; refunds unaffected. Mutation checks: running the check before the account lock lets more than 3 concurrent transfers through; not recording rejections fails 2 tests. Other test files run with permissive thresholds set by the test helper, as with rate limits.
