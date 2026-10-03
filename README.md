# Move-the-Money

A small HTTP API for moving money between accounts. It is built with Node.js, TypeScript, Express 5 and PostgreSQL.

The API enforces these rules, and the tests check each one against a real database:

- **No negative balances.** An account can never be overdrawn, even when many transfers run at once.
- **No lost or created money.** A transfer debits one account and credits another in one transaction, or does nothing.
- **Exact amounts.** Money is never stored or calculated as a JavaScript floating-point number.
- **Safe retries.** Retrying a transfer with the same `Idempotency-Key` never moves the money twice.
- **Owned accounts.** Users log in, and money can only leave an account its owner controls.
- **A double-entry ledger.** Every movement writes balanced debit and credit entries that can't be edited, and every balance can be rebuilt from them.

See [BUILD_LOG.md](BUILD_LOG.md) for how this was built, including how AI was used.

---

## Running it

### Requirements

- Node.js 22 or newer
- PostgreSQL 13 or newer (developed on 18.4 with [Postgres.app](https://postgresapp.com/))
- Docker, for RabbitMQ and Redis: `docker compose up -d` (see `docker-compose.yml`)

### Setup

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
| `npm run reconcile` | Audits the ledger once, prints the report, exits 1 on any mismatch |
| `npm run worker:reconciliation` | Audits the ledger every `RECONCILIATION_INTERVAL_MS` (default hourly) |
| `npm run worker:webhooks` | Runs the webhook worker (event fan-out and HTTP delivery) |
| `npm test` | Runs the test suite |
| `npm run test:log` | Runs the tests and also writes the results to `test-results.log` |

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none (required) | The app refuses to start without it |
| `PORT` | `3000` | Must be a valid port number |
| `JWT_SECRET` | none (required by the server) | At least 32 characters; signs access tokens. Migrations don't need it |
| `JWT_TTL_SECONDS` | `3600` | Access token lifetime |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | Message broker for domain events |
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
| `TRANSFER_FEE_PERCENT` | `0` | Fee charged to the sender on top of each transfer, e.g. `1` or `0.25`. `.env.example` sets `1` |
| `TEST_DATABASE_URL` | `DATABASE_URL` with `_test` appended to the database name | Used only by the tests |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `LOG_FILE` | `logs/app.log` | Set to `off` to log to the console only |

### Request and correlation ids

Every response carries `X-Request-Id` (this request) and `X-Correlation-Id` (the whole piece of work). Send your own `X-Correlation-Id` to tie several requests together; otherwise it equals the request id. It is logged with each request and carried into the events a request produces, so one id follows a transfer from the API call through RabbitMQ to its notifications and webhooks.

### Logs and debugging

While the app runs, every request is logged as one JSON line to the console and to `logs/app.log`. The file is appended to across restarts and ignored by git.

```json
{"time":"…","level":"warn","msg":"request rejected","request_id":"99356229-…","method":"GET","path":"/accounts/…","status":404,"duration_ms":5.7,"error_code":"account_not_found"}
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

The suite has 241 tests. Most send real HTTP requests to the app running on a random port, and all of them use a real database with no mocks.

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
| `logging.test.ts` | Requests are written to the log file with id, status and error code; bodies and keys never are |
| `health.test.ts` | `/health` and `/ready`, including `/ready` returning 503 when the database is down |

The concurrency tests run each scenario 5 times, because a race can pass by luck in a single run. During development, each important safeguard (lock ordering, the guarded debit, the idempotency lock) was removed on purpose to confirm that the tests fail without it.

### Demo: the database fails in the middle of a transfer

With the API running (`npm run dev`), in another terminal:

```bash
node scripts/crash-demo.js
```

The script pauses a transfer after it has debited and credited inside its transaction, then kills its database connection. It shows that other sessions never see the uncommitted change, the client gets a 500, no money is lost, and retrying with the same `Idempotency-Key` runs the transfer exactly once.

---

## API

All endpoints below are under **`/api/v1`** (for example `POST /api/v1/transfers`); only `/health` and `/ready` are at the root. All request and response bodies are JSON. Every endpoint except `/auth/register`, `/auth/login`, `/health` and `/ready` needs an access token:

```
Authorization: Bearer <token>
```

### `POST /auth/register` and `POST /auth/login`

```bash
curl -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email": "ada@example.com", "password": "at least 8 chars"}'
```

```json
201 Created
{ "user": { "id": "…", "email": "ada@example.com", "created_at": "…" }, "token": "eyJhbGciOi…" }
```

`/auth/login` takes the same body and returns `200` with the same shape. A wrong password and an unknown email both return `401 invalid_credentials`, so the API doesn't reveal which emails are registered. `GET /auth/me` returns the current user.

Passwords are hashed with scrypt. Tokens are HS256 JWTs that expire after `JWT_TTL_SECONDS`.

### Ownership

Accounts belong to the user who opened them. `GET /accounts` lists your accounts. Someone else's account returns `404`, not `403`, so account ids can't be probed. You can pay into any account, but money can only leave an account you own.

Amounts in requests and responses are always JSON strings. **Amounts are always strings** such as `"100.00"`, in both directions. A JSON number is rejected, because it may already have been rounded by floating point before the server sees it.

### `POST /accounts`: create an account

```bash
curl -X POST localhost:3000/api/v1/accounts -H 'content-type: application/json' \
  -d '{"first_name": "Ada", "last_name": "Lovelace", "starting_balance": "100.00"}'
```

```json
201 Created
{
  "id": "2c5a2005-e312-42f2-9a32-78c6948610c2",
  "first_name": "Ada",
  "last_name": "Lovelace",
  "balance": "100.00",
  "created_at": "2026-09-27T10:01:58.197Z"
}
```

| Field | Rules |
|---|---|
| `first_name`, `last_name` | Required strings. Surrounding whitespace is trimmed. Must be 1–100 characters after trimming. |
| `starting_balance` | Required string. Greater than zero, at most 2 decimal places, at most 18 digits before the point. An account can still reach `0.00` later by spending. |

Unknown fields are rejected, so a typo like `startingBalance` fails instead of being ignored.

### `GET /accounts`: list your accounts

Returns `{ "data": [ …accounts… ] }`, oldest first.

### `GET /accounts/:id`: look up an account and its balance

Returns the same shape as above, with the current `balance`.

### `POST /transfers`: move money

```bash
curl -X POST localhost:3000/api/v1/transfers -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1234' \
  -d '{"from_account_id": "…", "to_account_id": "…", "amount": "30.00"}'
```

```json
201 Created
{
  "id": "73decf0e-e6e4-458d-92a1-88f4a7fa5be6",
  "from_account_id": "…",
  "to_account_id": "…",
  "amount": "30.00",
  "created_at": "2026-09-27T10:44:57.548Z"
}
```

- `amount` must be greater than zero, with the same format rules as `starting_balance`.
- The two accounts must be different.
- **`Idempotency-Key` header (required):** 1–255 printable ASCII characters, no spaces. Generate a new one (for example a UUID) for each transfer you intend, and reuse it for retries of that transfer. A request without one gets `400 missing_idempotency_key`.
  - Same key and same request: returns the original transfer with `201` and `Idempotent-Replayed: true`, and no money moves.
  - Same key and a different request (different accounts or amount): `409`.
  - A failed request, such as one with insufficient funds, does not use up its key, so it can be retried.

### `POST /transfers/:id/refund`: refund a transfer you received

```bash
curl -X POST localhost:3000/api/v1/transfers/<id>/refund -H 'Authorization: Bearer …' -H 'Idempotency-Key: refund-1234'
```

Returns `201` with a new transfer of kind `refund`, from the receiver back to the sender, with `refund_of` pointing at the original. The original transfer is never changed.

- Only the owner of the receiving account can refund (`403 refund_not_allowed` for the sender, `404` for anyone else).
- A transfer can be refunded once (`409 already_refunded`). Refunds and deposits can't be refunded (`422 not_refundable`).
- The full amount is returned; the fee is not.
- The receiver must still have the money (`422 insufficient_funds`).
- `Idempotency-Key` is required, and works like it does for transfers.

### Notifications

`GET /notifications` returns your notifications, newest first, with `unread_count`. Filter with `?unread=true`, limit with `?limit=` (1–100). `POST /notifications/:id/read` marks one read; `POST /notifications/read-all` marks all.

They're written by the notification worker from events: "You sent 12.50 to …bbbb (fee 0.13).", "You received 12.50 from …aaaa.", refunds, and account openings. A transfer flagged by risk checks says so.

### Webhooks

```bash
curl -X POST localhost:3000/api/v1/webhooks -H 'Authorization: Bearer …' -H 'content-type: application/json' \
  -d '{"url": "https://example.com/hooks/payments", "events": ["transfer.completed", "transfer.refunded"]}'
```

Returns `201` with the endpoint and its `secret` (shown only this once). `GET /webhooks` lists your endpoints, `DELETE /webhooks/:id` deactivates one, and `GET /webhooks/:id/deliveries` shows recent deliveries with their status, attempts, last HTTP status and error.

Events: `account.created`, `transfer.completed`, `transfer.refunded`. You receive the events for transfers you sent or received, and for accounts you opened. Each delivery is a `POST` with the event as JSON and these headers:

- `Webhook-Id`: the delivery id (stable across retries, use it to deduplicate)
- `Webhook-Event`: the event type
- `Webhook-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with your secret>`

Verify the signature and reject timestamps older than a few minutes, so captured deliveries can't be replayed (`verifyWebhookSignature` in `src/webhooks/signing.ts` shows how). Any non-2xx response or a timeout is retried with exponential backoff; after the last attempt the delivery is marked `dead`.

### `GET /transfers/:id`: one transfer with its ledger entries

Visible to the owner of either account. Returns the transfer plus `ledger_entries`, for example:

```json
{ "id": "…", "kind": "transfer", "from_account_id": "A", "to_account_id": "B", "amount": "7.00", "created_at": "…",
  "ledger_entries": [
    { "account_id": "A", "direction": "debit",  "amount": "7.00", "created_at": "…" },
    { "account_id": "B", "direction": "credit", "amount": "7.00", "created_at": "…" } ] }
```

Every transfer has a `kind`: `transfer` (between customers), `deposit` (an account's opening balance), `refund`, or `adjustment` (written once by the ledger migration for pre-ledger data). Transfers also carry `fee` and `refund_of`, and the detail view adds `refunded_by`.

### `GET /accounts/:id/transactions`: transaction history

Returns the transfers the account sent or received, newest first. Each item is labelled from that account's point of view: money out is a `debit`, money in is a `credit`.

```bash
curl 'localhost:3000/api/v1/accounts/…/transactions?limit=10'
```

```json
200 OK
{
  "data": [
    { "id": "…", "from_account_id": "…", "to_account_id": "…", "amount": "12.50",
      "created_at": "…", "direction": "credit" }
  ]
}
```

`limit` is optional, from 1 to 100, and defaults to 50.

### `GET /health` and `GET /ready`: for load balancers and deploy platforms

- `/health` returns `200 {"status": "ok"}` whenever the process is up. It never touches the database, so a database outage doesn't get the process restarted.
- `/ready` returns `200 {"status": "ready"}` when the database is reachable, and `503 not_ready` when it isn't, so traffic can be held back until the app can do real work.

### Errors

Every error has the same shape:

```json
{ "error": "insufficient_funds", "message": "Source account has insufficient funds" }
```

| Status | `error` | When |
|---|---|---|
| 400 | `malformed_json` | The body isn't valid JSON |
| 400 | `invalid_email` | Registration email isn't a valid address |
| 400 | `invalid_password` | Registration password isn't 8–128 characters |
| 401 | `missing_token` | No `Authorization: Bearer` header |
| 401 | `invalid_token` | The token is expired, tampered with, or signed with another secret |
| 401 | `invalid_credentials` | Login email or password is wrong |
| 409 | `email_taken` | Registration email is already used (case-insensitive) |
| 400 | `invalid_body` | The body is JSON but not an object |
| 400 | `unknown_field` | The body has a field the endpoint doesn't accept |
| 400 | `missing_field` | A required field is absent |
| 400 | `invalid_amount` | Not a string, zero or negative, more than 2 decimals, or more than 18 integer digits |
| 400 | `invalid_name` | Not a string, empty after trimming, or over 100 characters |
| 400 | `invalid_account_id` | Not a UUID |
| 400 | `same_account` | `from_account_id` equals `to_account_id` |
| 400 | `missing_idempotency_key` | `POST /transfers` without an `Idempotency-Key` header |
| 400 | `invalid_idempotency_key` | The header is empty, too long, or has spaces or non-ASCII characters |
| 400 | `invalid_limit` | `limit` isn't an integer from 1 to 100 |
| 404 | `account_not_found` | The account doesn't exist |
| 404 | `transfer_not_found` | The transfer doesn't exist or you aren't a party to it |
| 404 | `not_found` | Unknown route |
| 405 | `method_not_allowed` | Known route, wrong method. The `Allow` header lists the valid methods. |
| 409 | `idempotency_key_conflict` | The key was already used for a different request |
| 409 | `already_refunded` | The transfer was already refunded |
| 403 | `refund_not_allowed` | Only the receiving account's owner can refund |
| 422 | `not_refundable` | Refunds and deposits can't be refunded |
| 413 | `payload_too_large` | The body is over 100 KB |
| 415 | `unsupported_media_type` | The body isn't `application/json` |
| 400 | `invalid_url` / `invalid_events` | Bad webhook URL (not http(s), or private when not allowed) or event list |
| 409 | `too_many_webhooks` | At most 10 active webhooks per user |
| 404 | `webhook_not_found` | The webhook doesn't exist or isn't yours |
| 422 | `risk_rejected` | Declined by risk checks. The body includes `reasons`, e.g. `["amount_over_limit"]` |
| 429 | `rate_limited` | Too many requests. `Retry-After` says how many seconds to wait |
| 422 | `insufficient_funds` | The source balance is lower than the amount |
| 500 | `internal_error` | Unexpected. Details are logged on the server and never sent to the client. |
| 503 | `not_ready` | `GET /ready` only: the database is unreachable |

---

## Design decisions

### Why PostgreSQL

The hard parts of this problem are transactions, row locks and constraints, and PostgreSQL handles all three well. The database is the final safeguard, not just storage:

- `CHECK (balance >= 0)` means no bug in the application can leave an account negative.
- `CHECK (amount > 0)` and `CHECK (from_account_id <> to_account_id)` apply the same idea to transfers.
- Foreign keys stop a transfer from pointing at an account that doesn't exist.

During development this paid off. With the application's locking deliberately removed, concurrent overspends failed on the balance constraint instead of losing money.

### Why `pg` and raw SQL (no ORM)

The correctness of a transfer depends on the exact SQL and the order it runs in: which rows are locked, in what order, and what is compared inside the `UPDATE`. With `pg` all of that is visible in [src/services/transfers.ts](src/services/transfers.ts). An ORM would hide it behind an abstraction that has to be reverse-engineered to reason about locking.

### Why `NUMERIC(20,2)` and not BIGINT cents

Both are exact. `NUMERIC(20,2)` was chosen because:

- The stored value, the API value and the value a person reads are all the same (`"100.50"`), so no conversion layer between cents and decimals is needed.
- `pg` returns `NUMERIC` as a string, and the application keeps it that way. Balance checks and arithmetic happen in SQL, so money never becomes a JavaScript number.
- 18 integer digits is far beyond any realistic balance. A JSON number loses precision well before that, which is one more reason amounts must be sent as strings.

### Double-entry ledger

Every movement of money is a row in `transfers` plus balanced rows in `ledger_entries`: a debit on the account money leaves, a credit on the account it reaches. `accounts.balance` is kept as a running total for fast reads and locking, and the ledger is the audit trail it can be rebuilt from (the `account_ledger_balances` view does exactly that).

- **Where money comes from.** Two platform-owned system accounts exist: `funding` and `fees`. An account's opening balance is a `deposit` from `funding`, which goes negative by everything ever deposited, so the sum of all balances is always exactly zero.
- **Enforced by the database, not just the code.** A trigger rejects any `UPDATE` or `DELETE` on ledger entries, and a deferred constraint trigger rejects the `COMMIT` of any transfer whose debits don't equal its credits.
- **Balances have more room than amounts.** One amount is capped at 18 integer digits, but a balance is `NUMERIC(38,2)`, because it can accumulate many amounts (and funding holds the negated total).
- **Existing data was backfilled.** The migration gave every pre-ledger transfer its entries, and recorded any unexplained opening balance as an `adjustment` from `funding`. Before applying it, it was run against a copy of a real development database: afterwards every account reconciled and all balances summed to 0.00.

### Transactional outbox

Every money movement also writes a domain event (`account.created`, `transfer.completed`, `transfer.refunded`) into `outbox_events`, **in the same transaction**. An event therefore exists if and only if the money moved: a rolled-back transfer leaves no event, and a committed one can't lose its event if the broker is down.

A separate relay worker (`npm run worker:outbox`) publishes pending events to RabbitMQ oldest first, waits for the broker's publisher confirm, and only then marks them published. It claims rows with `FOR UPDATE SKIP LOCKED`, so several relays can run at once without publishing an event twice. Delivery is at-least-once: if the relay dies after publishing but before recording it, the event is sent again, so consumers deduplicate by event id.

### Event processing with RabbitMQ

Events are published to a topic exchange (`mtm.events`) with the event type as routing key. Each consumer has its own durable queue bound to the types it needs, so every consumer gets its own copy.

- **Idempotent consumers.** Each event id is recorded in `processed_events` in the same transaction as the consumer's own writes. A redelivered event finds its row and is acknowledged without running the handler again.
- **Retries with backoff.** A failing message is re-published to a delay queue (1s, then 5s, then 25s); when the delay expires it returns to the consumer's queue. After the last delay it goes to the consumer's dead-letter queue.
- **Nothing is lost while moving a message.** A retry or dead-letter copy is confirmed by the broker before the original is acknowledged.
- **Malformed messages** go straight to the dead-letter queue, since retrying can't fix them.
- **Money never depends on the broker.** RabbitMQ only carries events about money that has already moved; if it's down, transfers still work and events wait in the outbox.

### Risk checks

Every transfer is assessed before money moves: `approve`, `review` (allowed, but flagged with `risk_decision: "review"`) or `reject` (`422 risk_rejected` with `reasons`). The rules are deliberately simple stand-ins for a real fraud model: amount thresholds, transfers per minute per account, large transfers from accounts under a day old, and repeated recent rejections.

The check runs inside the transfer's transaction, after the source account is locked, so concurrent transfers from one account are serialized and the per-minute count can't be raced. Every decision is stored in `risk_decisions`; rejections are written after the rollback, on their own connection, so they're kept. Replays and refunds aren't re-checked.

It's a synchronous module rather than a separate service, because the decision must be made before the money moves. Slower analysis that doesn't gate a transfer could consume `transfer.completed` events instead.

### Redis: rate limiting and caching

- **Rate limits.** 100 requests per minute per logged-in user, and 10 login or registration attempts per minute per IP. The limiter is a sliding-window log run as a single Lua script, so concurrent requests can't both take the last slot. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a rejected request gets `429` with `Retry-After`.
- **Account cache.** `GET /accounts/:id` is cached for 30 seconds (`X-Cache: HIT` or `MISS`). Every transfer and refund deletes both accounts' entries after it commits. A cache hit still checks ownership.
- **Redis is never the source of truth.** Transfers always read and lock balances in PostgreSQL. If Redis is down, the limiter allows requests and the cache is bypassed (fail-open), with commands timing out after 250 ms so a slow Redis can't stall the API.

### Reconciliation

`npm run reconcile` (or the reconciliation worker, hourly) audits the books:

1. every account's `balance` equals its balance rebuilt from the ledger;
2. every transfer's debits equal its credits;
3. every transfer's entries move exactly its amount plus fee;
4. no transfer is missing its entries;
5. all balances, system accounts included, sum to exactly zero.

Each check is one SQL statement, so a transfer committing mid-run can't produce a false alarm; together they run in one REPEATABLE READ transaction so the report describes a single moment. Every run is stored in `reconciliation_runs` with its issues, and a mismatch is logged at error level for monitoring to alert on.

### Concurrency strategy

Each transfer runs in a single transaction ([src/services/transfers.ts](src/services/transfers.ts)):

```sql
SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE;       -- 1. lock both accounts
UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1; -- 2. guarded debit
UPDATE accounts SET balance = balance + $1 WHERE id = $2;                  -- 3. credit
INSERT INTO transfers ...;                                                -- 4. record
```

1. **`FOR UPDATE` locks both accounts** for the length of the transaction. A second transfer touching either account waits, and then sees the updated balance.
2. **`ORDER BY id` prevents deadlocks.** If A→B locked A first and B→A locked B first, each would wait for the other forever. Sorting means every transfer locks the lower id first. Without the sort, 100 concurrent A↔B transfers deadlocked 85 times in testing. With it, none did.
3. **The balance check is part of the debit statement.** If the balance is too low, zero rows are updated and the API returns 422. There is no gap between checking and debiting, and the comparison happens in SQL.
4. The lock query also detects missing accounts. If it returns fewer than two rows, the API returns 404 before any money moves.

### Idempotency strategy

Every transfer carries a client-generated `Idempotency-Key`, stored in a `UNIQUE` column on `transfers`. The transaction starts with:

```sql
SELECT pg_advisory_xact_lock(hashtextextended($key, 0));
```

This makes all requests with the same key wait in line, and the lock is released automatically at commit or rollback. The request that gets the lock looks the key up:

- If the key isn't found, the transfer runs and stores the key.
- If it's found and from, to and amount match, the original transfer is returned. The comparison is done in SQL, so `"100"` matches `"100.00"`.
- If it's found with different parameters, the API returns 409.

**Why not just catch the unique violation on insert?** Consider a 100.00 balance and a client that retries a 100.00 transfer while the first attempt is still in progress. The retry would fail its balance check with `insufficient_funds` before it ever reached the insert, so the client would get a 422 for a transfer that actually succeeded. Taking the lock first means the retry always waits for the first attempt and returns its result. The `UNIQUE` constraint remains as a backstop.

The hash only turns the key into a lock number. If two different keys hash to the same number, those requests wait for each other briefly, but the lookup compares the real key text, so the result is still correct.

### Other decisions

- **Accounts must open with a balance greater than zero.** An account is created with money in it, so `"0"` is rejected. A balance can still reach `0.00` later by spending, which is why the database constraint is `balance >= 0` and not `> 0`.
- **`Idempotency-Key` is required.** Without a client-chosen key, the server cannot tell a retry of one transfer from two intentional identical transfers, so an optional key would let the same transfer submitted twice be applied twice. Requiring it makes that impossible: the same key replays, and a different key is a new transfer. The cost is that every client has to generate a key, including quick `curl` tests.
- **A failed transfer does not use up its key.** Only successful transfers are stored, so after a 422 or a 500 the same key can be retried, for example after topping up the account. The trade-off is that a key whose first attempt failed can then be used for a different request without a 409. Some payment APIs store failed results as well, so a retry returns the same failure. That approach is stricter, but it needs a separate table for attempts.

---

## What I chose not to build

- **Refresh tokens and logout.** Access tokens simply expire; there is no refresh flow or revocation list yet.
- **Idempotency key expiry.** Keys are kept forever. Real systems usually keep them for about 24 hours.
- **Cursor pagination on history.** Only the newest 100 transfers of an account can be fetched. Cursor pagination is more machinery than this project needs.
- **Listing all accounts, closing accounts, and currencies.** None were required, so there is a single implied currency.
- **Rate limiting.**

## What I would do next

See [docs/roadmap.md](docs/roadmap.md) for the V2 milestones in progress. Beyond those:

1. Expire idempotency keys after about 24 hours with a scheduled cleanup.
2. Add cursor pagination to history (keyset on `created_at, id`) once accounts have long histories.
3. Add graceful shutdown that drains in-flight transactions before the process exits.
4. Add refresh tokens and token revocation.

---

## Project layout

```
migrations/            numbered SQL files, applied in order by src/db/migrate.ts
scripts/crash-demo.js  kills a transfer's DB connection mid-transaction to show atomicity + idempotency
src/
  app.ts               builds the Express app (no listen, so tests can start it)
  index.ts             starts the server
  config.ts            reads env vars and fails fast on bad config
  db/index.ts          connection pool and withTransaction()
  db/migrate.ts        migration runner (advisory-locked, one transaction per file)
  routes/              HTTP layer: parse and validate, then call a service
  services/            SQL and business rules
  middleware/          request logging, JSON-only bodies, 404/405, error → JSON
  logger.ts            JSON-lines logger (console + LOG_FILE)
  money.ts             amount parsing (string-only, NUMERIC(20,2) format)
  validation.ts        body, id and name parsing
test/                  node:test suites against a real Postgres
```
