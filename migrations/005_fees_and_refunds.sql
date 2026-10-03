-- Transfer fees and compensating refunds. A refund never edits or deletes the
-- original transfer; it is a new transfer in the opposite direction that points back.

ALTER TABLE transfers ADD COLUMN fee NUMERIC(20, 2) NOT NULL DEFAULT 0
  CONSTRAINT transfers_fee_non_negative CHECK (fee >= 0);

ALTER TABLE transfers ADD COLUMN refund_of UUID REFERENCES transfers (id);
-- A transfer can be refunded at most once.
ALTER TABLE transfers ADD CONSTRAINT transfers_refund_of_unique UNIQUE (refund_of);

ALTER TABLE transfers DROP CONSTRAINT transfers_kind_valid;
ALTER TABLE transfers ADD CONSTRAINT transfers_kind_valid
  CHECK (kind IN ('transfer', 'deposit', 'adjustment', 'refund'));
ALTER TABLE transfers ADD CONSTRAINT transfers_refund_link
  CHECK ((kind = 'refund') = (refund_of IS NOT NULL));
