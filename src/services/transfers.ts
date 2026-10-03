import type { PoolClient } from 'pg';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { HttpError } from '../errors';
import { postLedgerEntries, SYSTEM_ACCOUNTS, type LedgerLine } from '../ledger';
import { enqueueEvent } from '../outbox';

export interface Transfer {
  id: string;
  kind: 'transfer' | 'deposit' | 'adjustment' | 'refund';
  from_account_id: string;
  to_account_id: string;
  amount: string;
  /** Charged to the sender on top of the amount; 0.00 when fees are off. */
  fee: string;
  /** For a refund, the transfer it reverses. */
  refund_of: string | null;
  created_at: Date;
}

export interface TransferResult {
  transfer: Transfer;
  /** True when the idempotency key matched an earlier request and no money moved. */
  replayed: boolean;
}

const TRANSFER_COLUMNS = 'id, kind, from_account_id, to_account_id, amount, fee, refund_of, created_at';

const isZero = (amount: string) => /^0+(\.0+)?$/.test(amount);

function keyConflict(): HttpError {
  return new HttpError(409, 'idempotency_key_conflict', 'Idempotency-Key was already used for a different request');
}

/**
 * Serializes requests that share a key, then returns what the key already produced.
 * Runs first in the transaction, so a concurrent retry waits for the first attempt
 * to commit and then finds it. Catching a unique violation at insert time would be
 * too late: a retry could fail with insufficient_funds before ever reaching the insert.
 */
async function claimIdempotencyKey(client: PoolClient, userId: string, key: string): Promise<Transfer | undefined> {
  // Keys are per user, so the lock is on (user, key).
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))", [userId, key]);
  const { rows } = await client.query<Transfer>(
    `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE initiated_by = $1 AND idempotency_key = $2`,
    [userId, key],
  );
  return rows[0];
}

interface LockedAccount {
  id: string;
  user_id: string | null;
  kind: string;
}

/** Locks accounts in id order, so two transfers between the same accounts can't deadlock. */
async function lockAccounts(client: PoolClient, ids: string[]): Promise<LockedAccount[]> {
  const { rows } = await client.query<LockedAccount>(
    'SELECT id, user_id, kind FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  return rows;
}

/** Debits only if the balance covers it: the check and the debit are one statement. */
async function guardedDebit(client: PoolClient, accountId: string, total: string): Promise<boolean> {
  const { rowCount } = await client.query(
    'UPDATE accounts SET balance = balance - $1::numeric WHERE id = $2 AND balance >= $1::numeric',
    [total, accountId],
  );
  return rowCount === 1;
}

/**
 * Moves money between two accounts, charging the configured fee to the sender.
 * Balances, the transfer row and its ledger entries commit together or not at all.
 */
export async function createTransfer(input: {
  /** The authenticated user; must own the source account. */
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  idempotencyKey: string;
  /** Carried into the published event as its correlation id. */
  requestId?: string;
}): Promise<TransferResult> {
  const { userId, fromAccountId, toAccountId, amount, idempotencyKey } = input;
  return withTransaction(async (client) => {
    const existing = await claimIdempotencyKey(client, userId, idempotencyKey);
    if (existing) {
      const { rows } = await client.query<{ same: boolean }>('SELECT $1::numeric = $2::numeric AS same', [
        existing.amount,
        amount,
      ]);
      const same =
        existing.kind === 'transfer' &&
        existing.from_account_id === fromAccountId.toLowerCase() &&
        existing.to_account_id === toAccountId.toLowerCase() &&
        rows[0]!.same;
      if (!same) throw keyConflict();
      return { transfer: existing, replayed: true };
    }

    const locked = await lockAccounts(client, [fromAccountId, toAccountId]);
    // Postgres returns ids lowercased, so compare against lowercased input.
    const source = locked.find((row) => row.id === fromAccountId.toLowerCase());
    // Money can only leave an account its owner controls. Someone else's account looks missing.
    if (!source || source.user_id !== userId) {
      throw new HttpError(404, 'account_not_found', 'Source account not found');
    }
    // System accounts (funding, fees) can't receive ordinary transfers.
    const destination = locked.find((row) => row.id === toAccountId.toLowerCase() && row.kind === 'customer');
    if (!destination) {
      throw new HttpError(404, 'account_not_found', 'Destination account not found');
    }

    // Fee and total are computed in SQL, so money never becomes a JS number.
    const { rows: priced } = await client.query<{ fee: string; total: string }>(
      `SELECT fee::text, ($1::numeric + fee)::text AS total
         FROM (SELECT round($1::numeric * $2::numeric / 100, 2) AS fee) f`,
      [amount, config.transferFeePercent],
    );
    const { fee, total } = priced[0]!;

    if (!(await guardedDebit(client, fromAccountId, total))) {
      throw new HttpError(422, 'insufficient_funds', 'Source account has insufficient funds');
    }
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toAccountId]);
    if (!isZero(fee)) {
      // Locked last, after the customer accounts, so lock order stays consistent.
      await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [fee, SYSTEM_ACCOUNTS.fees]);
    }

    const { rows } = await client.query<Transfer>(
      `INSERT INTO transfers (from_account_id, to_account_id, amount, fee, idempotency_key, initiated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${TRANSFER_COLUMNS}`,
      [fromAccountId, toAccountId, amount, fee, idempotencyKey, userId],
    );
    const transfer = rows[0]!;
    const lines: LedgerLine[] = [
      { accountId: fromAccountId, direction: 'debit', amount },
      { accountId: toAccountId, direction: 'credit', amount },
    ];
    if (!isZero(fee)) {
      lines.push(
        { accountId: fromAccountId, direction: 'debit', amount: fee },
        { accountId: SYSTEM_ACCOUNTS.fees, direction: 'credit', amount: fee },
      );
    }
    await postLedgerEntries(client, transfer.id, lines);
    await enqueueEvent(client, {
      type: 'transfer.completed',
      aggregateId: transfer.id,
      data: { transfer, from_user_id: userId, to_user_id: destination.user_id },
      correlationId: input.requestId,
    });
    return { transfer, replayed: false };
  });
}

/**
 * Refunds a transfer in full with a new, compensating transfer in the opposite
 * direction. The original is never modified. Only the receiving account's owner can
 * refund, a transfer can be refunded once, and the fee is not refunded.
 */
export async function refundTransfer(input: {
  userId: string;
  transferId: string;
  idempotencyKey: string;
  requestId?: string;
}): Promise<TransferResult> {
  const { userId, idempotencyKey } = input;
  const transferId = input.transferId.toLowerCase();
  return withTransaction(async (client) => {
    const existing = await claimIdempotencyKey(client, userId, idempotencyKey);
    if (existing) {
      if (existing.kind !== 'refund' || existing.refund_of !== transferId) throw keyConflict();
      return { transfer: existing, replayed: true };
    }

    // Lock the original, so two refunds of the same transfer can't race each other.
    const { rows } = await client.query<{
      kind: string;
      from_account_id: string;
      to_account_id: string;
      amount: string;
      sender_owner: string | null;
      receiver_owner: string | null;
    }>(
      `SELECT t.kind, t.from_account_id, t.to_account_id, t.amount,
              sender.user_id AS sender_owner, receiver.user_id AS receiver_owner
         FROM transfers t
         JOIN accounts sender ON sender.id = t.from_account_id
         JOIN accounts receiver ON receiver.id = t.to_account_id
        WHERE t.id = $1
          FOR UPDATE OF t`,
      [transferId],
    );
    const original = rows[0];
    if (!original || (original.sender_owner !== userId && original.receiver_owner !== userId)) {
      throw new HttpError(404, 'transfer_not_found', 'Transfer not found');
    }
    if (original.kind !== 'transfer') {
      throw new HttpError(422, 'not_refundable', 'Only ordinary transfers can be refunded');
    }
    if (original.receiver_owner !== userId) {
      throw new HttpError(403, 'refund_not_allowed', "Only the receiving account's owner can refund a transfer");
    }
    const { rows: already } = await client.query('SELECT 1 FROM transfers WHERE refund_of = $1', [transferId]);
    if (already.length > 0) {
      throw new HttpError(409, 'already_refunded', 'This transfer has already been refunded');
    }

    await lockAccounts(client, [original.from_account_id, original.to_account_id]);
    if (!(await guardedDebit(client, original.to_account_id, original.amount))) {
      throw new HttpError(422, 'insufficient_funds', 'The receiving account no longer has enough to refund this transfer');
    }
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [
      original.amount,
      original.from_account_id,
    ]);

    const { rows: inserted } = await client.query<Transfer>(
      `INSERT INTO transfers (kind, from_account_id, to_account_id, amount, refund_of, idempotency_key, initiated_by)
       VALUES ('refund', $1, $2, $3, $4, $5, $6)
       RETURNING ${TRANSFER_COLUMNS}`,
      [original.to_account_id, original.from_account_id, original.amount, transferId, idempotencyKey, userId],
    );
    const refund = inserted[0]!;
    await postLedgerEntries(client, refund.id, [
      { accountId: original.to_account_id, direction: 'debit', amount: original.amount },
      { accountId: original.from_account_id, direction: 'credit', amount: original.amount },
    ]);
    await enqueueEvent(client, {
      type: 'transfer.refunded',
      aggregateId: refund.id,
      // The refund moves money from the original receiver back to the original sender.
      data: { refund, original_transfer_id: transferId, from_user_id: userId, to_user_id: original.sender_owner },
      correlationId: input.requestId,
    });
    return { transfer: refund, replayed: false };
  });
}

export interface AccountTransaction extends Transfer {
  /** Relative to the requested account: money out is a debit, money in is a credit. */
  direction: 'debit' | 'credit';
}

/** Lists the most recent transfers into or out of an account, newest first. */
export async function listTransfersForAccount(accountId: string, limit: number): Promise<AccountTransaction[]> {
  const { rows } = await pool.query<AccountTransaction>(
    `SELECT ${TRANSFER_COLUMNS},
            CASE WHEN from_account_id = $1 THEN 'debit' ELSE 'credit' END AS direction
     FROM transfers
     WHERE from_account_id = $1 OR to_account_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

export interface LedgerEntry {
  account_id: string;
  direction: 'debit' | 'credit';
  amount: string;
  created_at: Date;
}

export interface TransferDetail extends Transfer {
  /** The refund that reversed this transfer, if any. */
  refunded_by: string | null;
  ledger_entries: LedgerEntry[];
}

/** A transfer with its ledger entries, if the user owns either side of it. */
export async function findTransferForUser(id: string, userId: string): Promise<TransferDetail | null> {
  const { rows } = await pool.query<Transfer & { refunded_by: string | null }>(
    `SELECT ${TRANSFER_COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')},
            (SELECT r.id FROM transfers r WHERE r.refund_of = t.id) AS refunded_by
       FROM transfers t
      WHERE t.id = $1
        AND EXISTS (SELECT 1 FROM accounts a
                     WHERE a.id IN (t.from_account_id, t.to_account_id) AND a.user_id = $2)`,
    [id, userId],
  );
  if (!rows[0]) return null;
  const { rows: entries } = await pool.query<LedgerEntry>(
    `SELECT account_id, direction, amount, created_at FROM ledger_entries
      WHERE transfer_id = $1 ORDER BY direction DESC, account_id, amount`,
    [id],
  );
  return { ...rows[0], ledger_entries: entries };
}
