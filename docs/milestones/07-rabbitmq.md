# 7. RabbitMQ event processing

**What.**
- The outbox relay now publishes to RabbitMQ (`RabbitPublisher`), on a topic exchange `mtm.events` with the event type as routing key.
- A reusable `EventConsumer`: idempotent processing, delayed retries with growing delays, and a dead-letter queue per consumer.
- `docker-compose.yml` runs RabbitMQ and Redis locally; CI runs RabbitMQ as a service.

**Why.** Things that should happen after money moves (notifications, webhooks, reconciliation checks) shouldn't slow down or break the transfer itself. A broker lets them run separately, scale separately, and retry on their own schedule.

**How.**
- **Publishing.** A confirm channel: `publish()` resolves only once the broker has accepted the message, with a 5 second timeout. Only then is the outbox row marked published.
- **Topology.** Per consumer: a durable queue bound to its event types, one delay queue per retry (TTL, then dead-letters back into the main queue), and a `.dead` queue.
- **Idempotency.** The consumer inserts `(consumer, event_id)` into `processed_events` with `ON CONFLICT DO NOTHING`, in the same transaction as the handler. If the row already existed, the handler is skipped. If the handler fails, the transaction rolls back, including that row, so the retry runs it again.
- **Retries.** The failed message is re-published to the next delay queue with an `x-attempt` header and `x-last-error`; after the last delay it goes to `.dead`. The copy is confirmed before the original is acknowledged, so a crash between the two can duplicate a message but never lose it (and duplicates are harmless).
- **Connection loss.** The relay worker exits with code 1 if the broker connection drops, so a process manager restarts it; a normal shutdown exits cleanly.

**Decisions.**
- **Fixed delay queues instead of per-message TTLs.** RabbitMQ only expires messages at the head of a queue, so one queue with mixed TTLs would hold short delays behind long ones.
- **Exit and restart on broker loss** instead of in-process reconnection logic: simpler, and the outbox guarantees nothing is lost in between.
- **The money path doesn't touch RabbitMQ.** A broker outage delays events; it never blocks or changes a transfer.
- Real consumers (notifications, webhooks) arrive in milestones 10 and 11.

**What can fail.**
- Messages in a dead-letter queue need a human: there is no replay tool yet.
- Ordering across events is not guaranteed (retries reorder); consumers must handle any order.

**How it was tested.** 7 tests in `test/messaging.test.ts` against a real RabbitMQ, each run with a unique queue prefix and its own database: a committed transfer reaches a consumer through relay and broker with matching event id and correlation id; routing by event type; the same event delivered twice is processed once; a handler failing twice is retried after at least 100 ms and 200 ms and its writes land exactly once; an always-failing handler ends in the dead-letter queue with `x-attempt` and the error; malformed messages are dead-lettered without calling the handler; a closed broker connection leaves events pending until a working publisher picks them up. Mutation checks: removing the event-id dedup fails 1 test; never retrying fails 2. The real worker was run against the dev database and broker (the exchange recorded the publish), shut down cleanly on SIGTERM, and exited with code 1 when RabbitMQ was restarted under it.
