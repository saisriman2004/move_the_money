-- In-app notifications, written by the notifications consumer from domain events.
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id),
  event_id   UUID NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One notification per user per event, however often the event is delivered.
  CONSTRAINT notifications_once UNIQUE (user_id, event_id)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
