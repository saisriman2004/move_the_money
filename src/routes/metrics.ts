import { Router } from 'express';
import { config } from '../config';
import { pool } from '../db';
import { HttpError } from '../errors';
import { registry, scrapeGauge } from '../metrics';

// Read at scrape time, so they always reflect the database right now.
scrapeGauge('outbox_pending_events', 'Outbox events not yet published', [], async (g) => {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
  g.set(rows[0]!.n);
});
scrapeGauge('outbox_oldest_pending_age_seconds', 'Age of the oldest unpublished outbox event (0 when none)', [], async (g) => {
  const { rows } = await pool.query<{ age: number }>(
    'SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS age FROM outbox_events WHERE published_at IS NULL',
  );
  g.set(rows[0]!.age);
});
scrapeGauge('webhook_deliveries', 'Webhook deliveries by status', ['status'], async (g) => {
  const { rows } = await pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM webhook_deliveries GROUP BY status');
  for (const status of ['pending', 'succeeded', 'dead']) g.set({ status }, rows.find((r) => r.status === status)?.n ?? 0);
});

export const metricsRouter = Router();

/** Prometheus scrape endpoint. Protect it with METRICS_TOKEN or keep it off the public network. */
metricsRouter.get('/metrics', async (req, res) => {
  if (config.metricsToken && req.get('Authorization') !== `Bearer ${config.metricsToken}`) {
    throw new HttpError(401, 'missing_token', 'Metrics require Authorization: Bearer <METRICS_TOKEN>');
  }
  res.set('Content-Type', registry.contentType).send(await registry.metrics());
});
