# 1. Harden tests, logging, health checks

**What.** Four small changes before building anything new:
- Test helper split: `createAccount()` always goes through the API; `createEmptyAccount()` inserts a 0.00 account directly, because the API only opens accounts with money in them.
- A test where one idempotency key is used concurrently for two transfers on different accounts. Exactly one gets 201, the other 409.
- Request bodies and idempotency keys are no longer logged.
- `GET /health` (the process is up) and `GET /ready` (the database is reachable, otherwise 503).

**Why.** The idempotency advisory lock had no test that would fail without it: a variant that relied only on account row locks passed every existing test. Bodies carry account ids and amounts, which don't belong in logs. Deploy platforms need liveness and readiness checks.

**How.** The new idempotency test sends two requests with the same key but disjoint accounts, so row locks never serialize them; only the key lock does. `/ready` runs `SELECT 1`; `/health` never touches the database, so a database outage doesn't make the platform restart a healthy process.

**What can fail.** If a platform is configured to restart on a failing `/ready`, it will restart during database outages; restarts should be tied to `/health`.

**How it was tested.** The new idempotency test is the only test that fails against the row-lock-only variant. The logging test fails against the old error handler (the body showed up in the log). `/ready` returning 503 is tested by mocking `pool.query` to throw.
