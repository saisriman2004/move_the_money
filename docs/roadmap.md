# V2 roadmap

Move-the-Money is being extended from the take-home API (tag `v1-take-home`) into a deployable payments platform. Work happens on the `v2` branch, one tested milestone per commit. Each milestone has an explainer in [milestones/](milestones/).

PostgreSQL stays the source of truth for money. Redis and RabbitMQ never decide balances or move money.

| # | Milestone | Status |
|---|---|---|
| 1 | Harden tests, logging, health checks | done |
| 2 | CI pipeline and linting | done |
| 3 | Authentication and account ownership | done |
| 4 | Double-entry ledger | done |
| 5 | Transfer fees and compensating refunds | done |
| 6 | Transactional outbox | planned |
| 7 | RabbitMQ event processing | planned |
| 8 | Redis rate limiting and caching | planned |
| 9 | Risk evaluation | planned |
| 10 | Signed webhooks with retries | planned |
| 11 | Event-driven notifications | planned |
| 12 | Ledger reconciliation | planned |
| 13 | API gateway layer: versioning, CORS, correlation ids | planned |
| 14 | React dashboard | planned |
| 15 | Metrics and observability | planned |
| 16 | Containerized full stack | planned |
| 17 | End-to-end and load tests | planned |
| 18 | Architecture documentation | planned |

## Shape

A modular monolith plus separate worker processes, not one service per box. The API is one Express app with modules (auth, accounts, transfers, risk, webhooks, notifications). Workers (outbox publisher, event consumers, reconciliation) run as separate processes from the same codebase, because they must scale and fail independently of request handling. Any module can be extracted into its own service later; each extraction should be justified by a real need.
