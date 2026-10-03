-- Every risk decision, including rejections (which never create a transfer).
CREATE TABLE risk_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id),
  from_account_id UUID NOT NULL REFERENCES accounts (id),
  amount          NUMERIC(20, 2) NOT NULL,
  decision        TEXT NOT NULL CONSTRAINT risk_decisions_decision_valid CHECK (decision IN ('approve', 'review', 'reject')),
  reasons         TEXT[] NOT NULL DEFAULT '{}',
  transfer_id     UUID REFERENCES transfers (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_decisions_account_idx ON risk_decisions (from_account_id, created_at);

-- The decision a transfer was allowed with: 'approve' or 'review'. NULL for deposits and refunds.
ALTER TABLE transfers ADD COLUMN risk_decision TEXT
  CONSTRAINT transfers_risk_decision_valid CHECK (risk_decision IN ('approve', 'review'));
