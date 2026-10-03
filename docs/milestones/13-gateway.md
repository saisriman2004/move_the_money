# 13. API gateway layer: versioning, CORS, correlation ids

**What.** The edge layer every request passes through, in `src/app.ts` and `src/gateway/`:
- All API routes under **`/api/v1`**; `/health` and `/ready` stay at the root for load balancers.
- **Correlation ids:** `X-Correlation-Id` is accepted (or defaults to the request id), returned, logged, and carried into outbox events, so one id follows a transfer from the HTTP call through RabbitMQ to notifications and webhooks.
- **CORS** for an allowlist (`CORS_ORIGINS`), with preflight answered before authentication and CORS headers on error responses too.
- **Security headers** (`nosniff`, `DENY` framing, `no-referrer`, `no-store`) and no `X-Powered-By`.
- **`TRUST_PROXY`**, so behind a load balancer `req.ip`, and therefore the per-IP login limit, is the real client.

The existing pieces of a gateway were already in place: JWT authentication (milestone 3), per-user and per-IP rate limiting (8), request ids and structured JSON errors (1).

**Why.** Versioning lets a `/api/v2` run alongside v1 without breaking clients. Correlation ids make a single payment traceable across processes. CORS and security headers are needed before a browser app (next milestone) talks to the API.

**Decisions.**
- **A layer, not a separate gateway service.** One process applies these concerns in order (ids → headers → CORS → body checks → auth → rate limit → route). An edge proxy such as nginx or Envoy could take over TLS, CORS and coarse rate limiting later, with the app keeping per-user logic. A separate Node gateway in front of a single API would add a network hop and a deployment without new capability.
- **Unversioned paths were removed**, not aliased. V2 hasn't been released, so there are no clients to keep working, and two paths per endpoint would double the surface to secure and test.
- **Request id vs correlation id.** The request id names one HTTP request; the correlation id names a piece of work that may span several requests and services.

**What can fail.** `TRUST_PROXY` must match the real number of proxies. Set too high, a client can spoof `X-Forwarded-For` and dodge the per-IP limit; set too low, everyone behind the proxy shares one limit.

**How it was tested.** 8 tests in `test/gateway.test.ts`: `/api/v1` works and unversioned, `/api/accounts` and `/api/v2` paths are 404 while `/health` stays at the root; a caller's correlation id is echoed and lands in the outbox event; it defaults to the request id and unsafe values are replaced; an allowed origin's preflight gets 204 with the allowed headers before authentication; an allowed origin can read a 401 and the exposed rate-limit headers; an unlisted origin gets no CORS headers; security headers on every response; per-IP login limits keyed on `X-Forwarded-For`. Mutation checks: reflecting any origin fails the allowlist test; not trusting the proxy fails the forwarded-IP test. The test helper now sends unversioned test paths to `/api/v1`, and the crash demo uses the new paths.
