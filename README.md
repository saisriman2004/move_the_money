# Move-the-Money

A small HTTP API for moving money between accounts. It is built with Node.js, TypeScript, Express 5 and PostgreSQL.

The API enforces these rules, and the tests check each one against a real database:

- **No negative balances.** An account can never be overdrawn, even when many transfers run at once.
- **No lost or created money.** A transfer debits one account and credits another in one transaction, or does nothing.
- **Exact amounts.** Money is never stored or calculated as a JavaScript floating-point number.
- **Safe retries.** Retrying a transfer with the same `Idempotency-Key` never moves the money twice.

See [BUILD_LOG.md](BUILD_LOG.md) for how this was built, including how AI was used.

---

## Running it

### Requirements

- Node.js 22 or newer
- PostgreSQL 13 or newer (developed on 18.4 with [Postgres.app](https://postgresapp.com/))

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
| `npm test` | Runs the test suite |
| `npm run test:log` | Runs the tests and also writes the results to `test-results.log` |

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none (required) | The app refuses to start without it |
| `PORT` | `3000` | Must be a valid port number |
| `TEST_DATABASE_URL` | `DATABASE_URL` with `_test` appended to the database name | Used only by the tests |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `LOG_FILE` | `logs/app.log` | Set to `off` to log to the console only |

### Logs and debugging

While the app runs, every request is logged as one JSON line to the console and to `logs/app.log`. The file is appended to across restarts and ignored by git.

```json
{"time":"…","level":"warn","msg":"request rejected","request_id":"99356229-…","method":"GET","path":"/accounts/…","status":404,"duration_ms":5.7,"error_code":"account_not_found"}
```

- Successful requests are logged as `info`, 4xx responses as `warn` (with the `error_code` that was returned), and 5xx responses as `error`.
- An unexpected 500 also writes an `unhandled error` line with the request body, the error message, the stack trace and any Postgres error code or constraint. None of this is sent to the client.
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

The suite has 139 tests. Most send real HTTP requests to the app running on a random port, and all of them use a real database with no mocks.

| File | Covers |
|---|---|
| `database.test.ts` | Migrations, schema constraints, `withTransaction` commit and rollback, including a connection that dies mid-query or during rollback |
| `accounts.test.ts` | Account creation and lookup, name and amount validation |
| `transfers.test.ts` | Transfers, exact decimal arithmetic, rollback when an account is missing, validation |
| `idempotency.test.ts` | Replays, conflicts, `"100"` matching `"100.00"`, concurrent retries with one key |
| `concurrency.test.ts` | Concurrent overspending, 100 opposite A↔B transfers without deadlock, total money conserved |
| `history.test.ts` | Transaction history: direction labels, ordering, `limit` |
| `errors.test.ts` | 415, 404 and 405 responses |
| `logging.test.ts` | Requests are written to the log file with id, status and error code |

The concurrency tests run each scenario 5 times, because a race can pass by luck in a single run. During development, each important safeguard (lock ordering, the guarded debit, the idempotency lock) was removed on purpose to confirm that the tests fail without it.

### Demo: the database fails in the middle of a transfer

With the API running (`npm run dev`), in another terminal:

```bash
node scripts/crash-demo.js
```

The script pauses a transfer after it has debited and credited inside its transaction, then kills its database connection. It shows that other sessions never see the uncommitted change, the client gets a 500, no money is lost, and retrying with the same `Idempotency-Key` runs the transfer exactly once.

---

## API

All request and response bodies are JSON. **Amounts are always strings** such as `"100.00"`, in both directions. A JSON number is rejected, because it may already have been rounded by floating point before the server sees it.

### `POST /accounts`: create an account

```bash
curl -X POST localhost:3000/accounts -H 'content-type: application/json' \
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

### `GET /accounts/:id`: look up an account and its balance

Returns the same shape as above, with the current `balance`.

### `POST /transfers`: move money

```bash
curl -X POST localhost:3000/transfers -H 'content-type: application/json' \
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
- **`Idempotency-Key` header (optional):** 1–255 printable ASCII characters, no spaces.
  - Same key and same request: returns the original transfer with `201` and `Idempotent-Replayed: true`, and no money moves.
  - Same key and a different request (different accounts or amount): `409`.
  - A failed request, such as one with insufficient funds, does not use up its key, so it can be retried.

### `GET /accounts/:id/transactions`: transaction history

Returns the transfers the account sent or received, newest first. Each item is labelled from that account's point of view: money out is a `debit`, money in is a `credit`.

```bash
curl 'localhost:3000/accounts/…/transactions?limit=10'
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

### Errors

Every error has the same shape:

```json
{ "error": "insufficient_funds", "message": "Source account has insufficient funds" }
```

| Status | `error` | When |
|---|---|---|
| 400 | `malformed_json` | The body isn't valid JSON |
| 400 | `invalid_body` | The body is JSON but not an object |
| 400 | `unknown_field` | The body has a field the endpoint doesn't accept |
| 400 | `missing_field` | A required field is absent |
| 400 | `invalid_amount` | Not a string, zero or negative, more than 2 decimals, or more than 18 integer digits |
| 400 | `invalid_name` | Not a string, empty after trimming, or over 100 characters |
| 400 | `invalid_account_id` | Not a UUID |
| 400 | `same_account` | `from_account_id` equals `to_account_id` |
| 400 | `invalid_idempotency_key` | The header is empty, too long, or has spaces or non-ASCII characters |
| 400 | `invalid_limit` | `limit` isn't an integer from 1 to 100 |
| 404 | `account_not_found` | The account doesn't exist |
| 404 | `not_found` | Unknown route |
| 405 | `method_not_allowed` | Known route, wrong method. The `Allow` header lists the valid methods. |
| 409 | `idempotency_key_conflict` | The key was already used for a different transfer |
| 413 | `payload_too_large` | The body is over 100 KB |
| 415 | `unsupported_media_type` | The body isn't `application/json` |
| 422 | `insufficient_funds` | The source balance is lower than the amount |
| 500 | `internal_error` | Unexpected. Details are logged on the server and never sent to the client. |

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

`Idempotency-Key` is stored in a `UNIQUE` column on `transfers`. When a key is present, the transaction starts with:

```sql
SELECT pg_advisory_xact_lock(hashtextextended($key, 0));
```

This makes all requests with the same key wait in line, and the lock is released automatically at commit or rollback. The request that gets the lock looks the key up:

- If the key isn't found, the transfer runs and stores the key.
- If it's found and from, to and amount match, the original transfer is returned. The comparison is done in SQL, so `"100"` matches `"100.00"`.
- If it's found with different parameters, the API returns 409.

**Why not just catch the unique violation on insert?** Consider a 100.00 balance and a client that retries a 100.00 transfer while the first attempt is still in progress. The retry would fail its balance check with `insufficient_funds` before it ever reached the insert, so the client would get a 422 for a transfer that actually succeeded. Taking the lock first means the retry always waits for the first attempt and returns its result. The `UNIQUE` constraint remains as a backstop.

The hash only turns the key into a lock number. If two different keys hash to the same number, those requests wait for each other briefly, but the lookup compares the real key text, so the result is still correct.

---

## What I chose not to build

- **Authentication and authorization.** Anyone can move money from any account. In a real system this would be the first thing to add.
- **Per-client idempotency keys.** Keys are global, so two clients using the same key would collide. With authentication, keys would be scoped per user.
- **Idempotency key expiry.** Keys are kept forever. Real systems usually keep them for about 24 hours.
- **Cursor pagination on history.** Only the newest 100 transfers of an account can be fetched. Cursor pagination is more machinery than this project needs.
- **Listing all accounts, closing accounts, and currencies.** None were required, so there is a single implied currency.
- **Rate limiting.**

## What I would do next

1. Add authentication, then scope accounts and idempotency keys to the authenticated user.
2. Expire idempotency keys after about 24 hours with a scheduled cleanup.
3. Add cursor pagination to history (keyset on `created_at, id`) once accounts have long histories.
4. Ship logs to a central store instead of a local file, and rotate `logs/app.log`, which currently grows forever.
5. Add a health endpoint for deployment, and graceful shutdown that drains in-flight transactions.
6. Run the test suite in CI against a PostgreSQL service container.
7. Add a nightly check that the sum of all balances equals the sum of all starting balances.

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
