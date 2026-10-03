-- One row per reconciliation run: what was checked and every issue found.
CREATE TABLE reconciliation_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CONSTRAINT reconciliation_runs_status_valid CHECK (status IN ('reconciled', 'mismatch')),
  accounts_checked  INTEGER NOT NULL,
  transfers_checked INTEGER NOT NULL,
  issues            JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);
