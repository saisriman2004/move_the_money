# 3. Authentication and account ownership

**What.**
- `POST /auth/register`, `POST /auth/login`, `GET /auth/me`.
- Passwords hashed with scrypt; HS256 JWT access tokens (`JWT_SECRET`, `JWT_TTL_SECONDS`).
- Every account belongs to a user. `GET /accounts` lists yours; anyone else's account returns 404.
- Money can only leave an account its owner controls; you can pay into any account.
- Idempotency keys are now unique per user: `UNIQUE (initiated_by, idempotency_key)`.

**Why.** Without authentication, anyone who knew an account id could move its money. Scoping idempotency keys per user also fixes the V1 limitation where two clients choosing the same key collided.

**How.**
- `requireAuth` middleware reads `Authorization: Bearer <token>`, verifies it with the algorithm pinned to HS256 (which rejects `alg: none` tokens), and stores the user id in `res.locals`.
- The transfer's account lock query now also returns `user_id`; if the source account isn't the caller's, the transfer fails with the same 404 as a missing account, before any money moves.
- The idempotency advisory lock is taken on `user_id:key`, and the key lookup filters by `initiated_by`.
- Login hashes a dummy password when the email is unknown, so response time doesn't reveal which emails are registered. Both cases return the same 401.

**Decisions.**
- **404, not 403**, for other users' accounts, so account ids can't be probed for existence.
- **scrypt from Node's standard library** instead of bcrypt or argon2: no native dependency, memory-hard, and the parameters are stored with each hash so they can be raised later.
- **`user_id` is nullable.** Accounts from before this migration have no owner, and the platform's own system accounts (next milestone) never will. The API always sets it for new accounts.
- **The JWT secret is read lazily.** The migration runner doesn't issue tokens, so it shouldn't need the secret; the server checks it at startup and refuses to start without one.
- **Auth is a module in the API, not a separate service.** Same database and process; it can be extracted later.

**What can fail.**
- There are no refresh tokens or revocation: a stolen token works until it expires (1 hour by default).
- There's no login rate limiting yet; that comes with the Redis milestone.

**How it was tested.** 19 new tests in `test/auth.test.ts`: registration, case-insensitive unique emails, login, identical errors for wrong password and unknown email, expired / wrong-secret / `alg: none` / garbage tokens, listing only your accounts, 404 on others' accounts and history, refusing to move money out of someone else's account, unauthenticated transfers, and per-user keys. Mutation checks: removing the source ownership check, the per-user key lookup, or the owner filter on account reads each makes a test fail. Also found and fixed a test-setup bug where a local `.env` secret overrode the test secret (it would have passed in CI and failed locally).
