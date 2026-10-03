# API reference

Base path **`/api/v1`**. `/health`, `/ready` and `/metrics` are at the root. All bodies are JSON, and **money is always a JSON string** such as `"100.50"`: requests that send a number are rejected, and responses never contain one.

Every response carries `X-Request-Id` and `X-Correlation-Id`. Authenticated endpoints need `Authorization: Bearer <token>` from `/auth/login` or `/auth/register`. They are rate limited per user (`RateLimit-*` headers, `429` with `Retry-After`).

## `POST /auth/register` and `POST /auth/login`

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

## Ownership

Accounts belong to the user who opened them. `GET /accounts` lists your accounts. Someone else's account returns `404`, not `403`, so account ids can't be probed. You can pay into any account, but money can only leave an account you own.

A JSON number is rejected for any amount, because it may already have been rounded by floating point before the server sees it.

## `POST /accounts`: create an account

```bash
curl -X POST localhost:3000/api/v1/accounts -H 'Authorization: Bearer …' -H 'content-type: application/json' \
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

## `GET /accounts`: list your accounts

Returns `{ "data": [ …accounts… ] }`, oldest first.

## `GET /accounts/:id`: look up an account and its balance

Returns the same shape as above, with the current `balance`.

## `POST /transfers`: move money

```bash
curl -X POST localhost:3000/api/v1/transfers -H 'Authorization: Bearer …' -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1234' \
  -d '{"from_account_id": "…", "to_account_id": "…", "amount": "30.00"}'
```

```json
201 Created
{
  "id": "73decf0e-e6e4-458d-92a1-88f4a7fa5be6",
  "kind": "transfer",
  "from_account_id": "…",
  "to_account_id": "…",
  "amount": "30.00",
  "fee": "0.30",
  "refund_of": null,
  "risk_decision": "approve",
  "created_at": "2026-09-27T10:44:57.548Z"
}
```

- `amount` must be greater than zero, with the same format rules as `starting_balance`.
- The two accounts must be different. You must own the source account; the destination can be anyone's.
- The sender pays `amount` plus `fee` (`TRANSFER_FEE_PERCENT`, rounded to the cent). The balance must cover both.
- Risk checks run first: a transfer can be approved, allowed but flagged (`"risk_decision": "review"`), or declined with `422 risk_rejected` and `reasons`.
- **`Idempotency-Key` header (required):** 1–255 printable ASCII characters, no spaces, unique per user. Generate a new one (for example a UUID) for each transfer you intend, and reuse it for retries of that transfer. A request without one gets `400 missing_idempotency_key`.
  - Same key and same request: returns the original transfer with `201` and `Idempotent-Replayed: true`, and no money moves.
  - Same key and a different request (different accounts or amount): `409`.
  - A failed request, such as one with insufficient funds, does not use up its key, so it can be retried.

## `POST /transfers/:id/refund`: refund a transfer you received

```bash
curl -X POST localhost:3000/api/v1/transfers/<id>/refund -H 'Authorization: Bearer …' -H 'Idempotency-Key: refund-1234'
```

Returns `201` with a new transfer of kind `refund`, from the receiver back to the sender, with `refund_of` pointing at the original. The original transfer is never changed.

- Only the owner of the receiving account can refund (`403 refund_not_allowed` for the sender, `404` for anyone else).
- A transfer can be refunded once (`409 already_refunded`). Refunds and deposits can't be refunded (`422 not_refundable`).
- The full amount is returned; the fee is not.
- The receiver must still have the money (`422 insufficient_funds`).
- `Idempotency-Key` is required, and works like it does for transfers.

## Notifications

`GET /notifications` returns your notifications, newest first, with `unread_count`. Filter with `?unread=true`, limit with `?limit=` (1–100). `POST /notifications/:id/read` marks one read; `POST /notifications/read-all` marks all.

They're written by the notification worker from events: "You sent 12.50 to …bbbb (fee 0.13).", "You received 12.50 from …aaaa.", refunds, and account openings. A transfer flagged by risk checks says so.

## Webhooks

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

## `GET /transfers/:id`: one transfer with its ledger entries

Visible to the owner of either account. Returns the transfer plus `ledger_entries`, for example:

```json
{ "id": "…", "kind": "transfer", "from_account_id": "A", "to_account_id": "B", "amount": "7.00", "created_at": "…",
  "ledger_entries": [
    { "account_id": "A", "direction": "debit",  "amount": "7.00", "created_at": "…" },
    { "account_id": "B", "direction": "credit", "amount": "7.00", "created_at": "…" } ] }
```

Every transfer has a `kind`: `transfer` (between customers), `deposit` (an account's opening balance), `refund`, or `adjustment` (written once by the ledger migration for pre-ledger data). Transfers also carry `fee` and `refund_of`, and the detail view adds `refunded_by`.

## `GET /accounts/:id/transactions`: transaction history

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

## `GET /health` and `GET /ready`: for load balancers and deploy platforms

- `/health` returns `200 {"status": "ok"}` whenever the process is up. It never touches the database, so a database outage doesn't get the process restarted.
- `/ready` returns `200 {"status": "ready"}` when the database is reachable, and `503 not_ready` when it isn't, so traffic can be held back until the app can do real work.

## Errors

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
