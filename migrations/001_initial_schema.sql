-- Money is stored as NUMERIC(20,2): exact decimal arithmetic in the database,
-- up to 18 digits before the decimal point, exactly 2 after.

CREATE TABLE accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Trimming and whitespace rules are enforced by the API, not here.
  first_name TEXT NOT NULL
    CONSTRAINT accounts_first_name_valid CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name  TEXT NOT NULL
    CONSTRAINT accounts_last_name_valid CHECK (length(last_name) BETWEEN 1 AND 100),
  balance    NUMERIC(20, 2) NOT NULL
    CONSTRAINT accounts_balance_non_negative CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id UUID NOT NULL REFERENCES accounts (id),
  to_account_id   UUID NOT NULL REFERENCES accounts (id),
  amount          NUMERIC(20, 2) NOT NULL
    CONSTRAINT transfers_amount_positive CHECK (amount > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfers_distinct_accounts CHECK (from_account_id <> to_account_id)
);

-- Supports per-account transaction history, newest first.
CREATE INDEX transfers_from_account_idx ON transfers (from_account_id, created_at DESC);
CREATE INDEX transfers_to_account_idx   ON transfers (to_account_id, created_at DESC);
