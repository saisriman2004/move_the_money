-- Consumers receive each event at least once. Recording (consumer, event id) in the
-- same transaction as the consumer's own writes makes reprocessing a no-op.
CREATE TABLE processed_events (
  consumer     TEXT NOT NULL,
  event_id     UUID NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
