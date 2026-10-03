# 17. End-to-end and load tests

**What.**
- `scripts/load-test.ts` (`npm run load-test`): a closed-loop load generator that records every request's latency, so p50 / p95 / p99 are exact. It runs three scenarios against a running stack: cached reads, transfers spread across 20 accounts, and a hot account.
- `docs/performance.md`: the measured results, the setup, and what the numbers do and don't mean.
- A CI job that builds the full stack with Docker Compose and runs the browser end-to-end test in Chrome.
- The compose file lets the rate limit and risk velocity limit be raised for load tests.

**The test types the plan asked for, and where each one lives:**

| Kind | Where |
|---|---|
| Unit | pure functions: risk rules, notification wording, money validation, retry keys, history filters |
| Integration (service ↔ PostgreSQL) | almost every backend test runs against a real database |
| Concurrency | `concurrency.test.ts`, plus concurrent cases in idempotency, fees and refunds, risk, outbox, webhooks, rate limits, reconciliation |
| Idempotency | `idempotency.test.ts`, refunds, consumers, webhook fan-out |
| Failure | database connection killed mid-transaction (`database.test.ts`, `scripts/crash-demo.js`), broker connection errors (`messaging.test.ts`), RabbitMQ restarted under the running stack (milestone 16) |
| Retry | consumer delay queues; webhook 500s, timeouts and dead deliveries |
| Rate limit | `redis.test.ts`: limit, sliding window, concurrent requests, per-IP login limit |
| Outbox | `outbox.test.ts`, plus the outbox-to-consumer end-to-end path in `messaging.test.ts` |
| Reconciliation | `reconciliation.test.ts`: each kind of corruption injected and detected |
| End to end | `frontend/e2e/app.e2e.mjs` in a real browser against the Docker stack |
| Load | `scripts/load-test.ts`; results in `docs/performance.md` |

**Results** (Apple M3, Docker Desktop with 4 GB RAM, 32 clients, through nginx):
- **Cached reads:** 2,275 req/s, p99 56.5 ms.
- **Spread transfers:** 460 req/s, p95 146.6 ms.
- **Hot-account transfers:** 314 req/s, p95 164.3 ms.

There were 0 errors in 61,035 requests. Reconciliation afterwards checked 15,559 transfers and found 0 issues, the outbox was empty, and nothing was dead-lettered.

**Decisions.**
- **A small custom load generator** rather than autocannon or k6: it reports exact percentiles (autocannon reports p97.5 rather than p95), creates its own accounts and per-request idempotency keys, and has no extra dependency.
- **Limits relaxed only for the test**, through environment variables, and restored afterwards.

**What can fail / honest limits.**
- The load generator and the whole stack shared one laptop, so the numbers are a baseline for comparison, not capacity.
- **The new CI e2e job has not run on GitHub yet.** It can't be triggered or watched from this machine (no `gh` CLI, private repository). Its steps are the ones run locally: compose up, then `npm run e2e`.
