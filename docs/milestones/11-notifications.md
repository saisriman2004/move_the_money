# 11. Event-driven notifications

**What.** A notification worker (`npm run worker:notifications`) consumes `account.created`, `transfer.completed` and `transfer.refunded`, and writes a readable message for each user involved. `GET /notifications` lists them with an unread count; they can be marked read one at a time or all at once.

**Why.** It's the user-facing side of the event pipeline: a payment someone else sent you shows up without the API that handled the transfer knowing anything about notifications.

**How.**
- `draftNotifications(event)` is a pure function from an event to messages: the sender gets "You sent 12.50 to …bbbb (fee 0.13).", the receiver "You received 12.50 from …aaaa.", a transfer between your own accounts produces one "You moved …" message, and transfers flagged by risk checks say so.
- `notifyFromEvent` inserts them in the consumer's transaction. `UNIQUE (user_id, event_id)` plus the consumer's `processed_events` make redelivery harmless.
- Account ids are shortened to their last four characters in messages.

**Decisions.**
- **Polling, not WebSockets or server-sent events.** The dashboard polls every few seconds. Browsers can't add an `Authorization` header to `EventSource`, so SSE would mean putting the token in the URL; WebSockets would add a connection layer to scale. Polling is enough here.
- **Messages are stored as rendered text**, with ids in `data` for links. Changing the wording later doesn't rewrite old notifications, which is usually what you want.

**What can fail.** Notifications arrive a moment after the transfer (relay plus consumer), not instantly. If the worker is down, they arrive when it restarts, because events wait in the queue.

**How it was tested.** 10 tests in `test/notifications.test.ts`: wording for sender and receiver with and without fees, review flags, own-account transfers, refunds and account openings; processing an event twice; each user seeing only their own notifications newest first with the right unread count; marking one and all read; 404 for someone else's notification; query validation; and a real transfer travelling API → outbox → RabbitMQ → consumer → `GET /notifications` for both users. Mutation checks: dropping the owner filter from listing fails 3 tests, and from mark-read fails 1.
