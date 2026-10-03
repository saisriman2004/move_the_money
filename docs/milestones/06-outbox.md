# 6. Transactional outbox

**What.** An `outbox_events` table and a relay worker (`npm run worker:outbox`). Opening an account, completing a transfer and refunding one each write an event (`account.created`, `transfer.completed`, `transfer.refunded`) in the same database transaction as the money movement.

**Why.** If the API published to a message broker directly after committing, a crash or broker outage between the commit and the publish would lose the event forever: money moved, but nobody downstream hears about it. Writing the event in the same transaction makes it all or nothing with the money; publishing happens afterwards and can be retried.

**How.**
- `enqueueEvent(client, …)` inserts the event using the transaction's own connection.
- `relayOutboxBatch()` claims pending rows oldest first with `FOR UPDATE SKIP LOCKED`, publishes each through an `EventPublisher`, and marks it published. A failed publish records `attempts` and `last_error` and leaves the row for the next batch.
- `runRelay()` loops until stopped, polling quickly while there is a backlog and backing off when the outbox is empty. The worker stops cleanly on SIGINT/SIGTERM.
- Each event carries the request id as `correlation_id`, so it can be traced back to the API call that caused it.
- Until RabbitMQ is added (milestone 7), the worker's publisher only logs events.

**Decisions.**
- **At-least-once delivery.** Exactly-once publishing to an external broker isn't possible; consumers deduplicate by event id instead.
- **Polling, not LISTEN/NOTIFY.** Simpler and survives reconnects; latency is at most the idle interval (500 ms).
- **Ordering.** One relay publishes in creation order. With several relays, `SKIP LOCKED` trades strict global order for throughput; consumers must not rely on cross-event ordering.
- **Isolated test databases.** The relay drains every pending row, so its tests run against their own database (`move_money_test_outbox`) via a new `isolatedDatabase` option in the test helper.

**What can fail.**
- The relay holds its batch transaction open while publishing; a broker that hangs holds those rows until it times out. The RabbitMQ publisher adds a timeout.
- Published rows are never deleted. A cleanup job would remove rows older than some retention period.

**How it was tested.** 9 tests in `test/outbox.test.ts`: a transfer writes exactly one event with both users and the request id; a rejected transfer and an idempotent replay write none; an event enqueued in a transaction that rolls back is never written; account and refund events; the relay publishes oldest first and never twice; a failed publish is recorded and retried; four concurrent relays publish 40+ events with no duplicates; `runRelay` keeps going until stopped. Mutation checks: writing the event outside the transaction fails the rollback test, and also deadlocked the connection pool under the concurrent tests (10 open transactions each waiting for an 11th connection), which is a second reason it must share the transaction. Removing the row locking from the relay makes the concurrency test fail with "an event was published twice". The real worker was also run against the dev database and relayed a live `account.created` event.
