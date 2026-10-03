import type { PoolClient } from 'pg';

export type EventType = 'account.created' | 'transfer.completed' | 'transfer.refunded';

/** The shape every published event has, whatever carries it. */
export interface DomainEvent<T = unknown> {
  id: string;
  type: EventType;
  occurred_at: string;
  correlation_id: string | null;
  data: T;
}

/**
 * Records an event in the caller's transaction. If the transaction rolls back,
 * the event disappears with it, so no event is ever published for money that didn't move.
 */
export async function enqueueEvent(
  client: PoolClient,
  event: { type: EventType; aggregateId: string; data: unknown; correlationId?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (event_type, aggregate_id, payload, correlation_id) VALUES ($1, $2, $3, $4)`,
    [event.type, event.aggregateId, JSON.stringify(event.data), event.correlationId ?? null],
  );
}
