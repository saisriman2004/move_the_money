-- Users own accounts; every transfer records which user initiated it.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Emails are compared case-insensitively.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Nullable: accounts created before authentication existed have no owner, and
-- platform-owned system accounts never will. The API sets it for every new account.
ALTER TABLE accounts ADD COLUMN user_id UUID REFERENCES users (id);
CREATE INDEX accounts_user_idx ON accounts (user_id, created_at);

ALTER TABLE transfers ADD COLUMN initiated_by UUID REFERENCES users (id);

-- Idempotency keys are now scoped per user, so two clients choosing the same key never collide.
ALTER TABLE transfers DROP CONSTRAINT transfers_idempotency_key_unique;
ALTER TABLE transfers ADD CONSTRAINT transfers_idempotency_key_unique UNIQUE (initiated_by, idempotency_key);
