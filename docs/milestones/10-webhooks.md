# 10. Signed webhooks with retries

**What.** Users register HTTP(S) endpoints for `account.created`, `transfer.completed` and `transfer.refunded` (`/webhooks`). When an event concerns them, their endpoints receive an HMAC-signed `POST`. Failures are retried with exponential backoff, and every attempt is visible through `GET /webhooks/:id/deliveries`.

**Why.** Webhooks are how a payments platform tells other systems that something happened. They have to cope with endpoints that are slow, down or wrong, without losing events or holding up anything else.

**How.**
- **Two stages.** A RabbitMQ consumer (`fanOutEvent`) turns each event into a `webhook_deliveries` row per subscribed, active endpoint of the users involved. It's idempotent through the consumer's `processed_events` and a `UNIQUE (endpoint_id, event_id)` constraint. A dispatcher loop then sends due deliveries. A slow customer endpoint only slows the dispatcher, never the queue.
- **Claiming with a lease.** The dispatcher claims due rows with `FOR UPDATE SKIP LOCKED` and pushes their `next_attempt_at` 60 seconds ahead, then commits, so HTTP calls happen outside any transaction. If a dispatcher dies mid-send, the lease expires and another one retries.
- **Signing.** `Webhook-Signature: t=<timestamp>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`. Signing the timestamp lets receivers reject replays; `verifyWebhookSignature` shows the receiver side with a constant-time comparison.
- **Retries.** Any non-2xx, timeout (5 s) or network error schedules the next attempt after base × 2^(n-1) with up to 20% jitter (10 s, 20 s, 40 s, …). After `WEBHOOK_MAX_ATTEMPTS` (8) the delivery is `dead`.
- **Safety.** URLs must be http(s); localhost, private, link-local (including the cloud metadata address 169.254.169.254) and IPv6 local addresses are refused unless `WEBHOOK_ALLOW_PRIVATE_URLS=true`. Redirects aren't followed. At most 10 active endpoints per user. Deleting an endpoint deactivates it and keeps its history.

**Decisions.**
- **Database-scheduled retries instead of broker delay queues.** Each delivery has its own schedule and history, which users can inspect; the broker's retry queues are for failures of the fan-out itself.
- **The secret is shown once** and stored in plain text, because the server needs it to sign. In production it would be encrypted at rest.

**What can fail.**
- The SSRF check looks at the URL's host, not where DNS points it (DNS rebinding). Full protection needs resolving and checking the IP at send time, or an egress proxy.
- Deliveries are at-least-once: a dispatcher that crashes after sending but before recording success sends again after its lease expires. Receivers deduplicate on `Webhook-Id`.
- Dead deliveries need a manual redelivery feature (not built).

**How it was tested.** 16 tests in `test/webhooks.test.ts`, with a real local HTTP server as the customer endpoint: secret shown once; invalid URLs and events; private addresses refused (including the metadata address) unless allowed; deactivation and 404 for others' webhooks; fan-out to exactly the subscribed, active endpoints of the involved users; no duplicate deliveries; a valid signature that fails with the wrong secret or a tampered body; old timestamps rejected; retries with gaps of at least 150 ms then 300 ms; a hanging endpoint timing out and ending `dead` after 3 attempts; redirects not followed; 4 concurrent dispatchers sending 15 deliveries exactly once; and a full path from `POST /transfers` through the outbox, RabbitMQ and fan-out to a verified HTTP delivery. Mutation checks: removing the lease and row locking duplicates deliveries; signing with the wrong secret fails 2 tests; a constant delay fails the backoff test.
