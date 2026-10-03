# 8. Redis rate limiting and caching

**What.**
- A sliding-window rate limiter: 100 requests/minute per logged-in user on `/accounts` and `/transfers`, and 10/minute per IP on `/auth/login` and `/auth/register`. Over the limit: `429 rate_limited` with `Retry-After`.
- A cache for `GET /accounts/:id` (30 s TTL, `X-Cache: HIT`/`MISS`), invalidated after every transfer and refund.

**Why.** Rate limits protect the service from abuse and runaway clients, and the per-IP login limit slows password guessing (flagged as missing in milestone 3). The cache takes repeated balance reads off PostgreSQL.

**How.**
- **Limiter.** A Lua script runs atomically in Redis: drop timestamps older than the window from a sorted set, count, and add the request only if under the limit. Because it's one script, 20 concurrent requests against a limit of 5 allow exactly 5.
- **Cache-aside.** Read Redis; on a miss, read PostgreSQL and store the account with its owner id. A hit still checks that the caller owns the account.
- **Invalidation after commit.** `createTransfer` and `refundTransfer` delete both accounts' cache entries once their transaction has committed, never before, so a reader can't re-cache the old balance from a transaction that hasn't finished.
- **Fail-open.** The client has no offline queue and a 250 ms command timeout. Any Redis error lets the request through and falls back to the database.

**Decisions.**
- **Fail-open, not fail-closed.** Redis holds nothing money depends on. If the limiter were fail-closed, a Redis outage would take the whole API down.
- **Redis isn't part of `/ready`**, for the same reason: the API works without it.
- **Sliding-window log** rather than a fixed window, which allows bursts of up to twice the limit at window boundaries.
- **Short TTL as a backstop.** There's a known cache-aside race: a reader that loaded the old balance just before a transfer committed could write it back just after the invalidation. The 30 s TTL bounds how long that can last, and transfers never use the cache.

**What can fail.**
- Behind a load balancer, `req.ip` is the proxy's address unless Express is told to trust the proxy (handled in the gateway milestone).
- Stale reads for up to the TTL in the race above.

**How it was tested.** 10 tests in `test/redis.test.ts` against a real Redis, with a 5-request limit and a 1.5 s window: headers and the 429; the window sliding; per-user isolation; 20 concurrent requests giving exactly 5 allowed; the per-IP login limit (four 401s, then 429s); fail-open with an unreachable Redis; cache miss then hit; invalidation after a transfer shows the new balance; a stranger gets 404 even on a cached account; entries expire after the TTL. Mutation checks: splitting the limiter into separate (non-atomic) commands lets too many concurrent requests through; removing invalidation and skipping the ownership check on hits each fail their test.
