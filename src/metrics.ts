import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** One registry per process. Each process (API or worker) exposes it at /metrics. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// --- API ---------------------------------------------------------------------
export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route template and status code',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});
export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by method and route template',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
export const apiErrors = new Counter({
  name: 'api_errors_total',
  help: 'Error responses by error code',
  labelNames: ['code', 'status'] as const,
  registers: [registry],
});
export const transfers = new Counter({
  name: 'transfers_total',
  help: 'Transfer requests by outcome: completed, replayed, or the error code that stopped them',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
export const rateLimitRejections = new Counter({
  name: 'rate_limit_rejections_total',
  help: 'Requests rejected with 429, by limiter',
  labelNames: ['scope'] as const,
  registers: [registry],
});

// --- Workers -----------------------------------------------------------------
export const eventsPublished = new Counter({
  name: 'outbox_events_published_total',
  help: 'Events the relay published to the broker',
  registers: [registry],
});
export const eventPublishFailures = new Counter({
  name: 'outbox_publish_failures_total',
  help: 'Failed attempts to publish an outbox event',
  registers: [registry],
});
export const eventsConsumed = new Counter({
  name: 'events_consumed_total',
  help: 'Events handled by a consumer, by outcome: processed, duplicate, retried, dead_lettered',
  labelNames: ['consumer', 'outcome'] as const,
  registers: [registry],
});
export const webhookAttempts = new Counter({
  name: 'webhook_delivery_attempts_total',
  help: 'Webhook HTTP attempts by result: succeeded, failed, dead',
  labelNames: ['result'] as const,
  registers: [registry],
});
export const reconciliationIssues = new Gauge({
  name: 'reconciliation_issues',
  help: 'Issues found by the most recent reconciliation run (0 when the books balance)',
  registers: [registry],
});
export const reconciliationLastRun = new Gauge({
  name: 'reconciliation_last_run_timestamp_seconds',
  help: 'When the most recent reconciliation run finished',
  registers: [registry],
});

/** A gauge whose value is read from somewhere (the database, the broker) at scrape time. */
export function scrapeGauge(name: string, help: string, labelNames: string[], read: (g: Gauge<string>) => Promise<void>) {
  return new Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      try {
        await read(this);
      } catch {
        // Leave the last value; a failed scrape of one gauge shouldn't fail /metrics.
      }
    },
  });
}

/**
 * Workers have no HTTP API, so each one serves /metrics and /health on its own
 * port (WORKER_METRICS_PORT). Returns the server so it can be closed on shutdown.
 */
export function startMetricsServer(port: number, service: string): Server {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType });
      res.end(await registry.metrics());
    } else if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port);
  return server;
}
