# Failure modes

What happens when each part of the system fails, and how that was verified. "Tested" means an automated test; "observed" means it was run against the real stack during development.

| Failure | What happens | Money impact | Verified |
|---|---|---|---|
| **Database connection dies mid-transfer** (after debit and credit, before commit) | PostgreSQL discards the uncommitted transaction; the client gets `500`; the broken connection is discarded; the server keeps running | None. Other sessions never saw the half-done transfer; a retry with the same key runs it once | Tested (`database.test.ts`); `scripts/crash-demo.js` |
| **Database unreachable** | `/ready` returns `503` so traffic is held back; `/health` stays `200` so the process isn't restarted needlessly; requests fail with `500` | None | Tested (`health.test.ts`) |
| **RabbitMQ down** | Transfers keep working. Events wait in the outbox (`outbox_oldest_pending_age_seconds` grows). Workers exit and are restarted by Docker until the broker is back, then the backlog drains | None. Notifications and webhooks are delayed, not lost | Observed: broker restarted under the running stack; workers recovered and the e2e test passed |
| **Broker connection error** (e.g. a missed heartbeat) | Logged; the following `close` stops the worker cleanly; Docker restarts it | None | Tested (`messaging.test.ts`). Previously crashed the relay; found during browser testing |
| **Relay crashes after publishing, before marking published** | The event is published again on restart | None. Consumers deduplicate by event id | By design (at-least-once); consumer dedup tested |
| **Duplicate event delivery** | The consumer finds the event id in `processed_events` and acknowledges it without running the handler | None | Tested (`messaging.test.ts`) |
| **Consumer handler fails** | Retried after 1 s, 5 s and 25 s through delay queues, then dead-lettered with the attempt count and error. Failed attempts roll back their writes | None | Tested |
| **Malformed message** | Dead-lettered immediately; the handler isn't called | None | Tested |
| **Customer webhook endpoint down, slow or erroring** | Retried with exponential backoff and jitter (10 s, 20 s, 40 s, …); 5 s timeout; redirects not followed; `dead` after 8 attempts. Other deliveries aren't held up | None | Tested with a scripted endpoint (500s, hangs, redirects) |
| **Webhook dispatcher crashes mid-send** | The claimed delivery's lease (60 s) expires, and another dispatcher retries it | None. The receiver may see it twice; `Webhook-Id` is stable for dedup | By design; concurrent dispatchers tested |
| **Redis down or slow** | Commands time out after 250 ms. Rate limiting fails open (requests allowed), the cache is bypassed and reads go to PostgreSQL | None. Redis never holds money state | Tested (unreachable Redis) |
| **Two retries of one payment at once** | The advisory lock on the key serializes them; the second replays the first | None | Tested (20 concurrent requests with one key) |
| **Same key reused for a different payment at once** | The second waits for the first, then gets `409` | None | Tested |
| **Client never gets the response** (network drop) | The web app and API clients retry with the same key; the server replays the original | None | Web app logic tested; replay tested |
| **Opposite transfers at once** (A→B and B→A) | Locks in id order, so they queue instead of deadlocking | None | Tested (100 concurrent, 5 rounds) |
| **Overspend race** | The second transfer waits for the lock, then fails the guarded debit with `422` | None | Tested |
| **Bug or manual SQL corrupts a balance** | Reconciliation reports it; an error is logged; `reconciliation_issues` > 0 | Detected, not prevented | Tested by injecting each kind of corruption |
| **Bad deploy writes an unbalanced ledger** | Rejected at `COMMIT` by the deferred trigger | Prevented | Tested |
| **Process stopped (SIGTERM)** | Workers stop their loops and close connections cleanly. The API doesn't yet drain in-flight requests | In-flight transactions roll back, so no money is lost; clients retry with their key | Observed for workers. API draining is listed as next work |

## Known gaps

- **Dead letters need a person.** There's no tool yet to inspect and replay dead-lettered messages or dead webhook deliveries.
- **Startup crash-loop.** While RabbitMQ is starting, workers exit and restart several times; a connect retry with backoff would be quieter.
- **Webhook SSRF.** Checks look at the URL's host, not where DNS resolves it (DNS rebinding).
- **No API drain on shutdown.** In-flight requests are cut off; their transactions roll back safely.
- **Stale cached balances** for up to 30 s in one known cache-aside race. Transfers never read the cache.
