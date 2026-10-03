import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { HttpError } from '../errors';
import { webhookAttempts } from '../metrics';
import type { DomainEvent, EventType } from '../outbox';
import { signWebhook } from './signing';

export const WEBHOOK_EVENTS: EventType[] = ['account.created', 'transfer.completed', 'transfer.refunded'];

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: Date;
}

const ENDPOINT_COLUMNS = 'id, url, events, active, created_at';

export async function createEndpoint(userId: string, url: string, events: string[]): Promise<WebhookEndpoint & { secret: string }> {
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  return withTransaction(async (client) => {
    // Serialize per user so two concurrent creations can't both pass the limit.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('webhooks:' || $1::text, 0))", [userId]);
    const { rows: count } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_endpoints WHERE user_id = $1 AND active',
      [userId],
    );
    if (count[0]!.n >= config.webhooks.maxEndpointsPerUser) {
      throw new HttpError(409, 'too_many_webhooks', `At most ${config.webhooks.maxEndpointsPerUser} active webhooks per user`);
    }
    const { rows } = await client.query<WebhookEndpoint>(
      `INSERT INTO webhook_endpoints (user_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING ${ENDPOINT_COLUMNS}`,
      [userId, url, secret, events],
    );
    return { ...rows[0]!, secret };
  });
}

export async function listEndpoints(userId: string): Promise<WebhookEndpoint[]> {
  const { rows } = await pool.query<WebhookEndpoint>(
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return rows;
}

/** Stops future deliveries. Kept, with its delivery history, rather than deleted. */
export async function deactivateEndpoint(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('UPDATE webhook_endpoints SET active = false WHERE id = $1 AND user_id = $2', [id, userId]);
  return rowCount === 1;
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'succeeded' | 'dead';
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: Date;
  created_at: Date;
  updated_at: Date;
}

export async function listDeliveries(userId: string, endpointId: string): Promise<WebhookDelivery[] | null> {
  const { rows: owned } = await pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1 AND user_id = $2', [endpointId, userId]);
  if (owned.length === 0) return null;
  const { rows } = await pool.query<WebhookDelivery>(
    `SELECT id, event_id, event_type, status, attempts, last_status_code, last_error, next_attempt_at, created_at, updated_at
       FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
    [endpointId],
  );
  return rows;
}

/** The users an event concerns: both parties of a transfer or refund, the owner of a new account. */
function usersFor(event: DomainEvent): string[] {
  const data = event.data as { from_user_id?: string | null; to_user_id?: string | null; user_id?: string | null };
  return [...new Set([data.from_user_id, data.to_user_id, data.user_id].filter((u): u is string => typeof u === 'string'))];
}

/**
 * Event consumer handler: turns one event into a pending delivery per subscribed,
 * active endpoint of the users it concerns. Runs in the consumer's transaction,
 * and the unique (endpoint, event) constraint makes it safe to run twice.
 */
export async function fanOutEvent(event: DomainEvent, client: PoolClient): Promise<number> {
  const users = usersFor(event);
  if (users.length === 0) return 0;
  const body = { id: event.id, type: event.type, occurred_at: event.occurred_at, data: event.data };
  const { rowCount } = await client.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload)
     SELECT e.id, $1, $2, $3
       FROM webhook_endpoints e
      WHERE e.active AND e.user_id = ANY($4::uuid[]) AND $2 = ANY(e.events)
     ON CONFLICT ON CONSTRAINT webhook_deliveries_once DO NOTHING`,
    [event.id, event.type, JSON.stringify(body), users],
  );
  return rowCount ?? 0;
}

interface ClaimedDelivery {
  id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

// How long a claimed delivery is hidden from other dispatchers while it's being sent.
const LEASE = '60 seconds';

/**
 * Claims due deliveries by pushing their next_attempt_at into the future (a lease),
 * then commits, so the HTTP calls happen outside any transaction. A dispatcher that
 * dies mid-delivery leaves the lease to expire, and another one retries the delivery.
 */
async function claimDue(limit: number): Promise<ClaimedDelivery[]> {
  const { rows } = await pool.query<ClaimedDelivery>(
    `UPDATE webhook_deliveries d
        SET next_attempt_at = now() + interval '${LEASE}', updated_at = now()
       FROM webhook_endpoints e
      WHERE d.endpoint_id = e.id
        AND d.id IN (SELECT id FROM webhook_deliveries
                      WHERE status = 'pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      LIMIT $1
                        FOR UPDATE SKIP LOCKED)
     RETURNING d.id, d.event_type, d.payload, d.attempts, e.url, e.secret`,
    [limit],
  );
  return rows;
}

async function send(delivery: ClaimedDelivery): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const body = JSON.stringify(delivery.payload);
  try {
    const res = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': delivery.id,
        'webhook-event': delivery.event_type,
        'webhook-signature': signWebhook(delivery.secret, body),
      },
      body,
      // Never follow redirects: the URL was validated, the redirect target wasn't.
      redirect: 'manual',
      signal: AbortSignal.timeout(config.webhooks.timeoutMs),
    });
    await res.body?.cancel();
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    return { ok: false, status: res.status, error: `endpoint responded ${res.status}` };
  } catch (err) {
    const e = err as Error;
    const message = e.name === 'TimeoutError' ? `timed out after ${config.webhooks.timeoutMs}ms` : e.message;
    return { ok: false, status: null, error: message };
  }
}

async function recordResult(delivery: ClaimedDelivery, result: Awaited<ReturnType<typeof send>>): Promise<void> {
  const attempts = delivery.attempts + 1;
  if (result.ok) {
    webhookAttempts.inc({ result: 'succeeded' });
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'succeeded', attempts = $2, last_status_code = $3, last_error = NULL, updated_at = now() WHERE id = $1`,
      [delivery.id, attempts, result.status],
    );
    return;
  }
  const dead = attempts >= config.webhooks.maxAttempts;
  webhookAttempts.inc({ result: dead ? 'dead' : 'failed' });
  // Exponential backoff with up to 20% jitter, so a recovering endpoint isn't hit by every retry at once.
  const delayMs = Math.round(config.webhooks.retryBaseMs * 2 ** (attempts - 1) * (1 + Math.random() * 0.2));
  await pool.query(
    `UPDATE webhook_deliveries
        SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
            next_attempt_at = now() + make_interval(secs => $6::double precision / 1000), updated_at = now()
      WHERE id = $1`,
    [delivery.id, dead ? 'dead' : 'pending', attempts, result.status, result.error, delayMs],
  );
}

/** Sends one batch of due deliveries concurrently. Returns how many were attempted. */
export async function dispatchDueDeliveries(limit = 20): Promise<number> {
  const due = await claimDue(limit);
  await Promise.all(due.map(async (d) => recordResult(d, await send(d))));
  return due.length;
}

export async function runDispatcher(options: { signal: AbortSignal; idleMs?: number; onError?: (err: unknown) => void }): Promise<void> {
  while (!options.signal.aborted) {
    let attempted = 0;
    try {
      attempted = await dispatchDueDeliveries();
    } catch (err) {
      options.onError?.(err);
    }
    if (attempted === 0) await new Promise((resolve) => setTimeout(resolve, options.idleMs ?? 500));
  }
}
