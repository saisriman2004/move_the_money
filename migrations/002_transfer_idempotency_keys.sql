-- Optional client-supplied key that makes POST /transfers safe to retry.
-- NULL for transfers sent without one; UNIQUE ignores NULLs.
ALTER TABLE transfers ADD COLUMN idempotency_key TEXT;
ALTER TABLE transfers ADD CONSTRAINT transfers_idempotency_key_unique UNIQUE (idempotency_key);
