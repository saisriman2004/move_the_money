-- Transactional outbox. Domain events are written in the same transaction as the
-- money movement they describe, so an event exists if and only if the money moved.
-- A relay worker publishes pending rows to the message broker afterwards.

CREATE TABLE outbox_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     TEXT NOT NULL,
  aggregate_id   UUID NOT NULL,
  payload        JSONB NOT NULL,
  -- The request that caused the event, for tracing it across services.
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at   TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT
);

-- The relay only ever looks for unpublished events, oldest first.
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at, id) WHERE published_at IS NULL;
