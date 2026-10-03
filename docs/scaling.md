# Scaling

How the system would grow, where it would hit limits first, and what to do about each. Measured numbers are in [performance.md](performance.md).

## What scales horizontally today

| Component | How | Why it's safe |
|---|---|---|
| **API** | Run more replicas behind nginx or a load balancer | Stateless: sessions are JWTs, money is in PostgreSQL, rate-limit counters are in Redis |
| **Outbox relay** | Run several | Rows are claimed with `FOR UPDATE SKIP LOCKED`; each event goes to one relay |
| **Consumers** (notifications, webhooks) | Run several per queue | RabbitMQ spreads messages across consumers; processing is idempotent |
| **Webhook dispatchers** | Run several | Deliveries are claimed with a lease and `SKIP LOCKED` |

## Where limits appear first

**1. Writes to PostgreSQL.** Every transfer writes about eight rows (two balances, the transfer, two to four ledger entries, a risk decision, an outbox event) in one transaction. One primary database bounds total write throughput.
- *Next steps:* faster storage and connection pooling (PgBouncer in transaction mode); trimming per-transfer writes (for example, batching risk decisions); then partitioning by account range (sharding), which turns cross-shard transfers into a distributed-transaction problem (two-phase commit, or a saga with a clearing account).

**2. Hot rows.** All transfers from one account queue on that account's row lock; measured as 314 req/s for one hot account against 460 req/s spread across 20. The system-wide hot rows are:
- `funding`, updated by every account opening;
- `fees`, updated by every fee-paying transfer.

*Next steps:* split each into N sub-accounts chosen at random and summed for reporting, or record their side only in the ledger and roll the balance up periodically.

**3. Outbox polling.** One relay polls every 500 ms when idle, and in batches of 100 when busy. Published rows are never deleted, so the table grows.
- *Next steps:* delete or archive published rows after a retention period; wake the relay with `LISTEN/NOTIFY` instead of polling; partition `outbox_events` by time.

**4. History and ledger size.** History reads use `(account, created_at)` indexes, but `ledger_entries` and `transfers` grow forever, and reconciliation scans everything.
- *Next steps:* cursor pagination for history; partition the ledger by month; make reconciliation incremental (checkpoint verified balances and audit only entries written since).

**5. RabbitMQ.** A single broker handles this load easily.
- *Next steps:* quorum queues for durability across a cluster; more consumers per queue before more queues.

**6. Redis.** A single instance; losing it loses only rate-limit counters and cache entries (fail-open).
- *Next steps:* a replica for availability; cluster mode only if the key count demands it.

## Reads

Balance reads come from a 30 s Redis cache, invalidated after each committed transfer (2,275 req/s cached through nginx on a laptop). Heavier read traffic, such as reporting and history, could move to a PostgreSQL read replica, accepting replication lag for those views. Transfers would keep reading and locking the primary.

## Splitting into services

The API is a modular monolith on purpose: the transfer, ledger, risk and outbox writes share one transaction. The natural extractions, and their cost:

- **Notifications and webhooks** are already separate processes connected only by events; they could become separate services with their own databases.
- **Auth** could move out (the API would verify tokens with a public key instead of a shared secret).
- **Risk** could become a service only if the transfer path tolerates a network call (and a fallback decision) before the money moves.
- **The money core** (accounts, transfers, ledger, outbox) should stay together. Splitting it means the guarantees in [financial-integrity.md](financial-integrity.md) would need distributed transactions or sagas.
