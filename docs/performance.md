# Performance

Measured with `scripts/load-test.ts` (`npm run load-test`), which records every request's latency, so the percentiles are exact.

## Setup

- **Machine:** an Apple M3 laptop (8 cores, 8 GB RAM). Docker Desktop VM with 8 CPUs and 4 GB RAM.
- **Stack:** the full `docker compose` stack: one API process, PostgreSQL 16, Redis, RabbitMQ, all four workers, and nginx in front. **The load generator ran on the same laptop.**
- **Path:** requests went through nginx (`http://localhost:8080`), as a browser's would.
- **Load:** 32 concurrent clients in a closed loop, 20 seconds per scenario.
- **Limits relaxed** for the test: `RATE_LIMIT_PER_MINUTE` and `RISK_MAX_TRANSFERS_PER_MINUTE` set very high, because the defaults (correctly) stop a single user doing hundreds of transfers a second. Fees were on (1%); at 0.01 per transfer the fee rounds to 0.00.

```bash
RATE_LIMIT_PER_MINUTE=100000000 RISK_MAX_TRANSFERS_PER_MINUTE=100000000 docker compose up -d --wait api
BASE_URL=http://localhost:8080 DURATION_S=20 CONCURRENCY=32 npm run load-test
docker compose up -d --wait api   # back to normal limits
```

## Results (2026-10-03)

| Scenario | Requests | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Read: `GET /accounts/:id` (Redis-cached) | 45,506 | 2,275 | 11.4 | 29.5 | 56.5 | 192 | 0 |
| Write: transfers across 20 accounts | 9,229 | 460 | 56.3 | 146.6 | 277.6 | 519 | 0 |
| Write: hot account (every transfer from one account) | 6,300 | 314 | 94.4 | 164.3 | 238.1 | 307 | 0 |

**After the run:**
- Reconciliation checked 15,559 transfers and found **0 issues**: every balance matches the ledger and all balances sum to zero.
- The outbox had **0 pending events**.
- The notification and webhook queues were empty, with **nothing dead-lettered**.
- 15,565 notifications had been written by the worker.

## What the numbers mean

- **A transfer is much more work than a read.** One `POST /transfers` takes an advisory lock and two row locks, runs the risk query, and writes balances, the transfer, its ledger entries, a risk decision and an outbox event, all in one transaction, then invalidates the cache. That's roughly 5× the latency of a cached read.
- **The hot account shows the cost of correctness.** When every transfer debits the same account, they queue on that row's lock, one at a time. Throughput drops about 30% and p50 rises from 56 ms to 94 ms, but nothing fails and the balance stays exact. That's the trade-off pessimistic locking makes on purpose.
- **This is one API process on a laptop that's also generating the load**, so treat the numbers as a baseline for comparing changes, not as a capacity figure. The API is stateless (state lives in PostgreSQL and Redis), so throughput would scale by running more API replicas behind nginx, until PostgreSQL write capacity becomes the limit.

## Where to go from here

- **Scale out:** run several API containers; the database is the shared bottleneck.
- **Hot rows:** shard fee and funding accounts (milestones 4 and 5 note why), and keep the critical section short.
- **Measure in production-like conditions:** a separate load-generator machine, a managed PostgreSQL with realistic disk latency, and longer runs.
