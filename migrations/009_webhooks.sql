-- Customer-registered webhook endpoints and every delivery attempt to them.

CREATE TABLE webhook_endpoints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id),
  url        TEXT NOT NULL,
  -- Used to sign each delivery (HMAC-SHA256). Shown to the user once, at creation.
  secret     TEXT NOT NULL,
  events     TEXT[] NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_user_idx ON webhook_endpoints (user_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      UUID NOT NULL REFERENCES webhook_endpoints (id),
  event_id         UUID NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT webhook_deliveries_status_valid CHECK (status IN ('pending', 'succeeded', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One delivery per endpoint per event, however often the event is redelivered.
  CONSTRAINT webhook_deliveries_once UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
