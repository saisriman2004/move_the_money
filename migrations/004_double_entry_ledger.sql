-- Double-entry ledger. Every movement of money is a transfer with balanced
-- ledger entries: total debits equal total credits. accounts.balance stays as a
-- fast running total; the ledger is the audit trail it can be rebuilt from.

-- Balances get more room than single amounts. One amount is capped at 18 integer
-- digits, but a balance can collect many of them, and the funding account holds
-- the negated total of everything ever deposited.
ALTER TABLE accounts ALTER COLUMN balance TYPE NUMERIC(38, 2);

-- System accounts belong to the platform, not a user. "funding" is where money
-- enters the system (opening balances), "fees" collects transfer fees. Funding is
-- allowed to go negative, so the sum of all balances is always exactly zero.
ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'customer'
  CONSTRAINT accounts_kind_valid CHECK (kind IN ('customer', 'system'));
ALTER TABLE accounts ADD COLUMN system_code TEXT UNIQUE;
ALTER TABLE accounts ADD CONSTRAINT accounts_system_code_matches_kind
  CHECK ((kind = 'system') = (system_code IS NOT NULL));

ALTER TABLE accounts DROP CONSTRAINT accounts_balance_non_negative;
ALTER TABLE accounts ADD CONSTRAINT accounts_balance_non_negative CHECK (kind = 'system' OR balance >= 0);

INSERT INTO accounts (id, kind, system_code, first_name, last_name, balance) VALUES
  ('00000000-0000-4000-8000-000000000001', 'system', 'funding', 'System', 'Funding', 0),
  ('00000000-0000-4000-8000-000000000002', 'system', 'fees', 'System', 'Fees', 0);

-- What a transfer represents. 'adjustment' only comes from the backfill below.
ALTER TABLE transfers ADD COLUMN kind TEXT NOT NULL DEFAULT 'transfer'
  CONSTRAINT transfers_kind_valid CHECK (kind IN ('transfer', 'deposit', 'adjustment'));

CREATE TABLE ledger_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES transfers (id),
  account_id  UUID NOT NULL REFERENCES accounts (id),
  direction   TEXT NOT NULL CONSTRAINT ledger_entries_direction_valid CHECK (direction IN ('debit', 'credit')),
  amount      NUMERIC(20, 2) NOT NULL CONSTRAINT ledger_entries_amount_positive CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at);

-- Entries are append-only. A mistake is corrected with a new, compensating
-- transfer, never by editing history.
CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are immutable' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ledger_entries_no_update_or_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

-- Checked at COMMIT, after all of a transfer's entries exist: debits must equal credits.
CREATE FUNCTION ledger_entries_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits  NUMERIC;
  credits NUMERIC;
BEGIN
  SELECT coalesce(sum(amount) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO debits, credits
    FROM ledger_entries WHERE transfer_id = NEW.transfer_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'ledger entries for transfer % are unbalanced: debits %, credits %', NEW.transfer_id, debits, credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_assert_balanced();

-- Each account's balance as the ledger says it should be.
CREATE VIEW account_ledger_balances AS
SELECT a.id AS account_id,
       a.balance,
       coalesce(sum(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END), 0)::NUMERIC(38, 2) AS ledger_balance
  FROM accounts a
  LEFT JOIN ledger_entries e ON e.account_id = a.id
 GROUP BY a.id, a.balance;

-- Backfill data written before the ledger existed, so every account reconciles.
-- 1. Give every existing transfer its two entries.
INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at)
SELECT t.id, t.from_account_id, 'debit', t.amount, t.created_at FROM transfers t
UNION ALL
SELECT t.id, t.to_account_id, 'credit', t.amount, t.created_at FROM transfers t;

-- 2. Whatever the transfers don't explain was an opening balance: record it as
--    an adjustment against the funding account, dated when the account was opened.
CREATE TEMP TABLE backfill_gaps ON COMMIT DROP AS
SELECT b.account_id, b.balance - b.ledger_balance AS gap, a.created_at
  FROM account_ledger_balances b JOIN accounts a ON a.id = b.account_id
 WHERE a.kind = 'customer' AND b.balance <> b.ledger_balance;

CREATE TEMP TABLE backfill_transfers ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, account_id, gap, created_at FROM backfill_gaps;

INSERT INTO transfers (id, kind, from_account_id, to_account_id, amount, created_at)
SELECT id, 'adjustment',
       CASE WHEN gap > 0 THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE account_id END,
       CASE WHEN gap > 0 THEN account_id ELSE '00000000-0000-4000-8000-000000000001'::uuid END,
       abs(gap), created_at
  FROM backfill_transfers;

INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at)
SELECT id, CASE WHEN gap > 0 THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE account_id END, 'debit', abs(gap), created_at
  FROM backfill_transfers
UNION ALL
SELECT id, CASE WHEN gap > 0 THEN account_id ELSE '00000000-0000-4000-8000-000000000001'::uuid END, 'credit', abs(gap), created_at
  FROM backfill_transfers;

UPDATE accounts SET balance = balance - (SELECT coalesce(sum(gap), 0) FROM backfill_gaps)
 WHERE id = '00000000-0000-4000-8000-000000000001';
