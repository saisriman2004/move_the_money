# 15. Metrics and observability

**What.**
- `GET /metrics` on the API, in Prometheus format, optionally protected by `METRICS_TOKEN`.
- A `/metrics` and `/health` server on every worker (`WORKER_METRICS_PORT`, defaults 9101–9104).
- A `service` field on every log line.

The metrics cover:
- HTTP traffic and latency per route template
- errors by code
- transfer outcomes, and 429s per limiter
- the outbox backlog and its oldest event's age
- relay publishes and failures, and consumer outcomes (processed / duplicate / retried / dead-lettered)
- queue and dead-letter depth
- webhook delivery states and attempts
- the last reconciliation result

**Why.** The questions an on-call engineer asks: Are payments succeeding? Why are they failing? Are events flowing? Is anything piling up in a dead-letter queue? Do the books balance? Each one is answered by a metric.

**How.**
- One `prom-client` registry per process, with Node's default process metrics.
- Route labels replace ids with `:id`, and unknown paths become `unmatched`. Label values come only from a fixed set, so a client can't create unbounded series by sending random URLs.
- Database-backed gauges (outbox backlog, webhook states) and broker-backed gauges (queue depth via `checkQueue`) are read at scrape time.
- `setService()` names each worker in its logs; `SERVICE_NAME` overrides it.

**Decisions.**
- **Pull metrics (Prometheus) rather than pushing** to a vendor: no new dependency at runtime, and any Prometheus-compatible system can scrape them.
- **`/metrics` outside `/api/v1`** and optionally token-protected: it's for infrastructure, and should normally only be reachable from the internal network.
- **No tracing system (OpenTelemetry) yet.** Correlation ids in logs give request-to-event tracing; spans with timings per hop would be the next step.

**What can fail.** If Prometheus isn't scraping, none of this alerts anyone. Alert rules (for example `outbox_oldest_pending_age_seconds > 60`, `reconciliation_issues > 0`, or any dead-lettered events) would live in the monitoring system, not this repo.

**How it was tested.** 6 tests in `test/metrics.test.ts` (own database, token set): 401 without or with a wrong token; a completed and an insufficient-funds transfer move `transfers_total` and `api_errors_total` by exactly one; requests are labelled `/api/v1/accounts/:id` with latency buckets; no UUID appears anywhere in the output, and unknown paths become `unmatched`; `outbox_pending_events` equals the database count; the worker metrics server serves `/metrics`, `/health` and 404. The logging test now checks the `service` field. Mutation check: labelling with raw paths fails 2 tests. Live check: the relay and notification worker answered `/health` and `/metrics` on 9101 and 9102, including queue depths from RabbitMQ.
