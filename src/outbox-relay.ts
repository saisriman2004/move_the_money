import { withTransaction } from './db';
import type { DomainEvent, EventType } from './outbox';

/** Anything that can deliver an event: RabbitMQ in production, a fake in tests. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * Publishes one batch of pending outbox events, oldest first.
 *
 * FOR UPDATE SKIP LOCKED lets several relays run at once: each claims a disjoint
 * set of rows. Delivery is at-least-once: if the process dies after publishing but
 * before committing published_at, the event is published again, so consumers must
 * deduplicate by event id.
 */
export async function relayOutboxBatch(publisher: EventPublisher, batchSize = 100): Promise<RelayResult> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      event_type: EventType;
      payload: unknown;
      correlation_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, event_type, payload, correlation_id, created_at
         FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY created_at, id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    const result: RelayResult = { published: 0, failed: 0 };
    for (const row of rows) {
      const event: DomainEvent = {
        id: row.id,
        type: row.event_type,
        occurred_at: row.created_at.toISOString(),
        correlation_id: row.correlation_id,
        data: row.payload,
      };
      try {
        await publisher.publish(event);
        await client.query('UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
        result.published++;
      } catch (err) {
        // Left unpublished; the next batch retries it.
        await client.query('UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
          row.id,
          (err as Error).message.slice(0, 1000),
        ]);
        result.failed++;
      }
    }
    return result;
  });
}

/**
 * Relays continuously until `signal` aborts. Polls quickly while there is a
 * backlog and backs off to `idleMs` when the outbox is empty.
 */
export async function runRelay(
  publisher: EventPublisher,
  options: { signal: AbortSignal; idleMs?: number; batchSize?: number; onError?: (err: unknown) => void },
): Promise<void> {
  const idleMs = options.idleMs ?? 500;
  while (!options.signal.aborted) {
    let busy = false;
    try {
      const { published, failed } = await relayOutboxBatch(publisher, options.batchSize);
      busy = published + failed > 0 && failed === 0;
    } catch (err) {
      options.onError?.(err);
    }
    if (!busy) await new Promise((resolve) => setTimeout(resolve, idleMs));
  }
}
