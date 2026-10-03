# Move the Money

A payments platform: users open accounts, send money to each other, get notified when money moves, and receive signed webhooks. Built with Node.js, TypeScript, Express, PostgreSQL, RabbitMQ, Redis and React, and run with Docker Compose.

The engineering focus is keeping money correct when things go wrong: concurrent requests, retries, crashes, and broker outages. Every guarantee below is enforced by PostgreSQL as well as the code, and checked by tests against real infrastructure:

- **No negative balances,** even under concurrent transfers (row locks in a fixed order, a guarded debit, a database constraint).
- **No money created or lost:** every movement is one transaction with balanced, immutable double-entry ledger entries, and all balances sum to zero.
- **Exactly-once effect for payments:** a required `Idempotency-Key`, serialized with an advisory lock, so a retried payment is never applied twice.
- **Exact amounts:** `NUMERIC` in the database and strings everywhere else; money never becomes a floating-point number.
- **Events that can't be lost:** a transactional outbox, at-least-once delivery through RabbitMQ, idempotent consumers, retries and dead-letter queues.
- **Detection of whatever slips through:** automated reconciliation of every balance against the ledger.

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, diagram, request and event paths, key decisions, data model |
| [docs/financial-integrity.md](docs/financial-integrity.md) | Each money guarantee, how it's enforced, and the evidence |
| [docs/failure-modes.md](docs/failure-modes.md) | What happens when each part fails |
| [docs/scaling.md](docs/scaling.md) | What scales, and where the limits are |
| [docs/api.md](docs/api.md) | Endpoint reference and error codes |
| [docs/performance.md](docs/performance.md) | Load-test results |
| [docs/milestones/](docs/milestones/) | How it was built, one milestone at a time: what, why, how, what can fail, how it was tested |

This started as a take-home transfer API (tag `v1-take-home`, with [BUILD_LOG.md](BUILD_LOG.md)) and grew into the platform in 18 milestones ([docs/roadmap.md](docs/roadmap.md)).

---

## Running it

### Everything in Docker (quickest)

```bash
docker compose up -d --build     # PostgreSQL, Redis, RabbitMQ, migrations, API, 4 workers, web app
open http://localhost:8080       # the web app (nginx serves it and proxies /api)
```

| Service | What it is | Port |
|---|---|---|
| `frontend` | nginx: the React app, and a proxy for `/api` | 8080 |
| `api` | the Express API | 3000 |
| `migrate` | applies migrations once, then exits; everything else waits for it | |
| `outbox-relay`, `notifications`, `webhooks`, `reconciliation` | workers; `/metrics` and `/health` on 9101–9104 inside the network | |
| `postgres`, `redis`, `rabbitmq` | infrastructure (RabbitMQ UI on 15672, user `mtm` / `mtm`) | |

Workers exit when they lose RabbitMQ and Docker restarts them (`restart: unless-stopped`); events wait safely in the outbox meanwhile. Set `JWT_SECRET` in the environment for anything beyond a local demo. `docker compose down -v` removes everything, including the database.

### Running the code directly

#### Requirements

- Node.js 22 or newer
- PostgreSQL 13 or newer (developed on 18.4 with [Postgres.app](https://postgresapp.com/))
- Docker, for RabbitMQ and Redis: `docker compose up -d rabbitmq redis` (needed by the API, the workers and the tests)

#### Setup

```bash
npm install
cp .env.example .env          # edit DATABASE_URL if your Postgres isn't on localhost:5432
createdb move_money           # or: psql -c 'CREATE DATABASE move_money'
npm run migrate               # applies migrations/*.sql
npm run dev                   # http://localhost:3000
```

`npm run migrate` is safe to run any number of times, because it only applies migrations that haven't been applied yet.

| Script | What it does |
|---|---|
| `npm run dev` | Starts the API with auto-reload |
| `npm run build` then `npm start` | Compiles to `dist/` and runs the compiled build |
| `npm run migrate` | Applies pending migrations |
| `npm run typecheck` | Type-checks `src/` and `test/` |
| `npm run lint` | Runs ESLint |
| `npm run worker:outbox` | Runs the outbox relay worker |
| `npm run worker:notifications` | Runs the notification worker |
| `npm run e2e` (in `frontend/`) | Browser end-to-end test against a running stack (default `http://localhost:8080`), using the installed Chrome |
| `npm run load-test` | Load test against a running stack; see [docs/performance.md](docs/performance.md) |
| `npm run reconcile` | Audits the ledger once, prints the report, exits 1 on any mismatch |
| `npm run worker:reconciliation` | Audits the ledger every `RECONCILIATION_INTERVAL_MS` (default hourly) |
| `npm run worker:webhooks` | Runs the webhook worker (event fan-out and HTTP delivery) |
| `npm test` | Runs the test suite |
| `npm run test:log` | Runs the tests and also writes the results to `test-results.log` |

### The web app

`frontend/` is a React + TypeScript dashboard (Vite). With the API running on port 3000:

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api to the API
npm test           # unit tests for money validation, retry keys and filters
npm run build      # static files in frontend/dist
```

Sign in or register, open accounts, send money, view history and each transfer's ledger entries, refund payments you received, read notifications (polled every 5 seconds), and manage webhooks under Developers. Notifications need the outbox relay and notification worker running.

Each payment gets its own `Idempotency-Key`. After a network error or a 5xx, **Retry** sends the same key, so a payment can't be applied twice; changing the form starts a new payment with a new key.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none (required) | The app refuses to start without it |
| `PORT` | `3000` | Must be a valid port number |
| `JWT_SECRET` | none (required by the server) | At least 32 characters; signs access tokens. Migrations don't need it |
| `JWT_TTL_SECONDS` | `3600` | Access token lifetime |
| `RABBITMQ_URL` | `amqp://mtm:mtm@localhost:5672` | Message broker for domain events |
| `AMQP_PREFIX` | `mtm.` | Prefix for every exchange and queue name |
| `CONSUMER_RETRY_DELAYS_MS` | `1000,5000,25000` | Delays before each retry of a failing message; after the last it is dead-lettered |
| `REDIS_URL` | `redis://localhost:6379` | Rate-limit counters and the account cache |
| `REDIS_PREFIX` | `mtm:` | Prefix for every Redis key |
| `RATE_LIMIT_PER_MINUTE` | `100` | Requests per minute for each logged-in user |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `10` | Login and registration attempts per minute for each IP |
| `ACCOUNT_CACHE_TTL_SECONDS` | `30` | How long `GET /accounts/:id` responses stay cached |
| `RISK_REVIEW_AMOUNT` / `RISK_REJECT_AMOUNT` | `1000.00` / `10000.00` | Transfers at or above these amounts are flagged for review / declined |
| `RISK_MAX_TRANSFERS_PER_MINUTE` | `10` | Transfers per minute from one account before further ones are declined |
| `RISK_NEW_ACCOUNT_HOURS` / `RISK_NEW_ACCOUNT_REVIEW_AMOUNT` | `24` / `500.00` | Accounts younger than this sending at least this much are flagged |
| `RISK_MAX_RECENT_REJECTIONS` | `3` | Declines in 10 minutes before every transfer from the account is declined |
| `WEBHOOK_TIMEOUT_MS` | `5000` | How long a customer endpoint has to answer |
| `WEBHOOK_MAX_ATTEMPTS` / `WEBHOOK_RETRY_BASE_MS` | `8` / `10000` | Attempts before a delivery is dead; retry n waits base × 2^(n-1) |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | `false` | Allow webhook URLs on localhost or private networks. Development only |
| `CORS_ORIGINS` | none | Comma-separated browser origins allowed to call the API |
| `TRUST_PROXY` | `false` | Proxies in front of the API (`1` behind one load balancer), so client IPs come from `X-Forwarded-For` |
| `METRICS_TOKEN` | none | If set, `GET /metrics` requires `Authorization: Bearer <token>` |
| `WORKER_METRICS_PORT` | 9101–9104 | Port for a worker's `/metrics` and `/health` (relay 9101, notifications 9102, webhooks 9103, reconciliation 9104) |
| `SERVICE_NAME` | per process | The `service` field on every log line |
| `TRANSFER_FEE_PERCENT` | `0` | Fee charged to the sender on top of each transfer, e.g. `1` or `0.25`. `.env.example` sets `1` |
| `TEST_DATABASE_URL` | `DATABASE_URL` with `_test` appended to the database name | Used only by the tests |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `LOG_FILE` | `logs/app.log` | Set to `off` to log to the console only |

### Request and correlation ids

Every response carries `X-Request-Id` (this request) and `X-Correlation-Id` (the whole piece of work). Send your own `X-Correlation-Id` to tie several requests together; otherwise it equals the request id. It is logged with each request and carried into the events a request produces, so one id follows a transfer from the API call through RabbitMQ to its notifications and webhooks.

### Metrics

`GET /metrics` serves Prometheus metrics for the API, and each worker serves its own on `WORKER_METRICS_PORT`:

| Metric | What it tells you |
|---|---|
| `http_requests_total`, `http_request_duration_seconds` | Traffic and latency per route template (ids replaced by `:id`) |
| `api_errors_total{code}` | Errors by API error code |
| `transfers_total{outcome}` | Completed, replayed, or the error that stopped a transfer (e.g. `insufficient_funds`, `risk_rejected`) |
| `rate_limit_rejections_total{scope}` | 429s per limiter |
| `outbox_pending_events`, `outbox_oldest_pending_age_seconds` | Whether events are flowing; a growing age means the relay is down |
| `outbox_events_published_total`, `outbox_publish_failures_total` | Relay throughput and broker failures |
| `events_consumed_total{consumer,outcome}` | Processed, duplicate, retried and dead-lettered events |
| `rabbitmq_queue_messages{queue}` | Backlog and dead-letter depth per consumer |
| `webhook_deliveries{status}`, `webhook_delivery_attempts_total{result}` | Webhook health |
| `reconciliation_issues`, `reconciliation_last_run_timestamp_seconds` | Whether the books balance, and how recently that was checked |

Health: the API has `/health` (process up) and `/ready` (database reachable); each worker has `/health` on its metrics port.

### Logs and debugging

While the app runs, every request is logged as one JSON line to the console and to `logs/app.log`. The file is appended to across restarts and ignored by git.

```json
{"time":"…","level":"warn","service":"api","msg":"request rejected","request_id":"99356229-…","correlation_id":"99356229-…","method":"GET","path":"/api/v1/accounts/…","status":404,"duration_ms":5.7,"error_code":"account_not_found"}
```

- Successful requests are logged as `info`, 4xx responses as `warn` (with the `error_code` that was returned), and 5xx responses as `error`.
- An unexpected 500 also writes an `unhandled error` line with the error message, the stack trace and any Postgres error code or constraint. None of this is sent to the client.
- Request bodies and idempotency keys are never logged, because bodies carry account ids and amounts. The request id is enough to correlate a log line with a client's response.
- Every response has an `X-Request-Id` header. Clients can also send their own. To find everything about one request, search for its id:

```bash
grep 99356229-ffd7-451b-9d95-85410acd0726 logs/app.log
grep '"level":"error"' logs/app.log        # every server-side failure
```

## Running the tests

```bash
npm test
```

The tests need PostgreSQL running, but no manual setup. They create a separate `move_money_test` database if it doesn't exist and migrate it. They never touch the development database.

The suite has 249 backend tests (plus 19 frontend unit tests). Most send real HTTP requests to the app running on a random port, and all of them use a real database with no mocks.

| File | Covers |
|---|---|
| `auth.test.ts` | Register, login, token validation (expired, wrong secret, `alg: none`), account ownership, per-user idempotency keys |
| `database.test.ts` | Migrations, schema constraints, `withTransaction` commit and rollback, including a connection that dies mid-query or during rollback |
| `accounts.test.ts` | Account creation and lookup, name and amount validation |
| `transfers.test.ts` | Transfers, exact decimal arithmetic, rollback when an account is missing, validation |
| `idempotency.test.ts` | Replays, conflicts, `"100"` matching `"100.00"`, concurrent retries with one key |
| `concurrency.test.ts` | Concurrent overspending, 100 opposite A↔B transfers without deadlock, total money conserved |
| `history.test.ts` | Transaction history: direction labels, ordering, `limit` |
| `errors.test.ts` | 415, 404 and 405 responses |
| `fees-refunds.test.ts` | 1% fees and rounding, fee ledger entries, balance must cover amount + fee, refunds (ownership, once only, concurrent, replay, insufficient funds) |
| `ledger.test.ts` | Balanced entries per transfer, balances rebuilt from the ledger, immutable entries, unbalanced writes rejected at commit, system accounts |
| `outbox.test.ts` | Events written in the money transaction (and rolled back with it), relay ordering, retries after a failed publish, concurrent relays publishing each event exactly once. Uses its own database |
| `messaging.test.ts` | Against a real RabbitMQ: outbox → broker → consumer with event and correlation ids, routing by event type, duplicate deliveries processed once, delayed retries, dead-lettering, broker outages. Uses its own database |
| `redis.test.ts` | Rate limits (headers, 429, sliding window, per user, concurrent requests, per-IP login limit, fail-open) and the account cache (hits, invalidation after transfers, ownership on hits, TTL) |
| `risk.test.ts` | Each risk rule as a pure function; approve / review / reject on real transfers; velocity limit under 10 concurrent transfers; repeated rejections; replays and refunds skip risk |
| `webhooks.test.ts` | Endpoint management and URL safety, fan-out to the right users, signed delivery, retries with growing delays, timeouts, dead deliveries, concurrent dispatchers, and API → RabbitMQ → webhook end to end. Uses its own database |
| `notifications.test.ts` | Message wording per event, one notification per user per event, listing / unread count / mark read, ownership, and a real transfer through RabbitMQ. Uses its own database |
| `reconciliation.test.ts` | A clean ledger reconciles; edited balances, unbalanced transfers, entries not matching amounts and missing entries are each reported; no false alarms during concurrent traffic. Uses its own database |
| `gateway.test.ts` | `/api/v1` versioning, correlation ids from request to event, CORS allowlist and preflight, security headers, `X-Forwarded-For` behind a trusted proxy |
| `metrics.test.ts` | `/metrics` token, transfer outcomes and error codes, route templates without ids, outbox backlog gauge, worker metrics server |
| `logging.test.ts` | Requests are written to the log file with id, status and error code; bodies and keys never are |
| `health.test.ts` | `/health` and `/ready`, including `/ready` returning 503 when the database is down |

A browser end-to-end test (`frontend/e2e/app.e2e.mjs`) drives the web app against the full Docker stack, and a load test (`scripts/load-test.ts`) measures throughput and exact latency percentiles; results are in [docs/performance.md](docs/performance.md).

The concurrency tests run each scenario 5 times, because a race can pass by luck in a single run. During development, each important safeguard (lock ordering, the guarded debit, the idempotency lock) was removed on purpose to confirm that the tests fail without it.

### Demo: the database fails in the middle of a transfer

With the API running (`npm run dev`), in another terminal:

```bash
node scripts/crash-demo.js
```

The script pauses a transfer after it has debited and credited inside its transaction, then kills its database connection. It shows that other sessions never see the uncommitted change, the client gets a 500, no money is lost, and retrying with the same `Idempotency-Key` runs the transfer exactly once.

---

## What I chose not to build

- **Multiple currencies.** There's a single implied currency; FX would need per-currency ledgers and conversion transfers.
- **Holding funds for review.** Risk "review" lets a transfer through and flags it; a real system might hold the money pending a decision.
- **Refresh tokens and revocation.** Access tokens simply expire (1 hour by default).
- **Admin tooling.** No UI or API for dead-lettered messages, dead webhook deliveries or reconciliation reports; they're in the database, logs and metrics.
- **Partial refunds, account closure, and idempotency key expiry.**

## What I would do next

1. A replay tool for dead letters and dead webhook deliveries.
2. Graceful API shutdown that drains in-flight requests, and connect-retry with backoff for workers starting before the broker.
3. Expire idempotency keys and archive published outbox rows after a retention period.
4. Shard the `funding` and `fees` hot rows; incremental reconciliation; cursor pagination for history.
5. OpenTelemetry tracing across the API, relay and consumers; alert rules for the metrics.
6. httpOnly-cookie sessions instead of tokens in `localStorage`, and DNS-aware webhook URL checks.

---

## Project layout

```
src/
  app.ts                 the Express app and gateway layer (ids, headers, CORS, auth, rate limits, /api/v1)
  index.ts               starts the API
  config.ts              environment configuration, validated at startup
  auth/                  password hashing and JWTs
  gateway/               CORS and security headers
  middleware/            request logging, auth, rate limiting, JSON-only bodies, 404/405, errors
  routes/                HTTP layer: parse and validate, then call a service
  services/              accounts, transfers and refunds (the money path), users
  ledger.ts              system accounts and ledger posting
  risk.ts                risk rules and facts
  outbox.ts, outbox-relay.ts   transactional outbox and its relay
  messaging/             RabbitMQ topology, publisher, idempotent consumer
  notifications/, webhooks/    event consumers and their APIs
  reconciliation.ts      ledger audit
  cache/, redis.ts       account cache and the Redis client
  metrics.ts, logger.ts  Prometheus metrics and JSON logs
  db/                    connection pool, withTransaction, migration runner
  workers/               entry points: outbox-relay, notifications, webhooks, reconciliation
migrations/              numbered SQL migrations 001–011
test/                    backend tests (node:test) against real PostgreSQL, RabbitMQ and Redis
frontend/                React + TypeScript app, unit tests, browser e2e test, nginx config
scripts/                 crash demo, load test, one-off reconciliation
docs/                    architecture, integrity, failure modes, scaling, API, performance, milestones
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```
