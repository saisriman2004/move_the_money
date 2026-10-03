import { pool, withTransaction } from '../db';
import { HttpError } from '../errors';

export interface Transfer {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  created_at: Date;
}

export interface TransferInput {
  /** The authenticated user; must own the source account. */
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  /** Required: identifies one logical transfer across retries. Scoped to the user. */
  idempotencyKey: string;
}

export interface TransferResult {
  transfer: Transfer;
  /** True when the idempotency key matched an earlier transfer and no money moved. */
  replayed: boolean;
}

const TRANSFER_COLUMNS = 'id, from_account_id, to_account_id, amount, created_at';

/**
 * Moves money between two accounts. The debit, the credit and the transfer
 * record commit together or not at all.
 */
export async function createTransfer({
  userId,
  fromAccountId,
  toAccountId,
  amount,
  idempotencyKey,
}: TransferInput): Promise<TransferResult> {
  return withTransaction(async (client) => {
    // Serialize requests sharing a key, before anything else, so a concurrent
    // retry waits for the first attempt to commit and then finds it below.
    // Catching a unique violation on insert instead would be too late: a retry
    // could fail with insufficient_funds before it ever reached the insert.
    // Keys are per user, so the lock is on (user, key).
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))", [userId, idempotencyKey]);
    const { rows: existing } = await client.query<Transfer & { matches: boolean }>(
      `SELECT ${TRANSFER_COLUMNS},
              (from_account_id = $2 AND to_account_id = $3 AND amount = $4::numeric) AS matches
       FROM transfers WHERE initiated_by = $5 AND idempotency_key = $1`,
      [idempotencyKey, fromAccountId, toAccountId, amount, userId],
    );
    if (existing[0]) {
      const { matches, ...transfer } = existing[0];
      if (!matches) {
        throw new HttpError(
          409,
          'idempotency_key_conflict',
          'Idempotency-Key was already used for a transfer with different parameters',
        );
      }
      return { transfer, replayed: true };
    }

    // Lock both accounts in a fixed (id) order. Without this, concurrent
    // transfers A->B and B->A can each lock one row and deadlock on the other.
    const { rows: locked } = await client.query<{ id: string; user_id: string | null }>(
      'SELECT id, user_id FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[fromAccountId, toAccountId]],
    );
    // Postgres returns ids lowercased, so compare against lowercased input.
    const source = locked.find((row) => row.id === fromAccountId.toLowerCase());
    // Money can only leave an account its owner controls. Someone else's account looks missing.
    if (!source || source.user_id !== userId) {
      throw new HttpError(404, 'account_not_found', 'Source account not found');
    }
    if (!locked.some((row) => row.id === toAccountId.toLowerCase())) {
      throw new HttpError(404, 'account_not_found', 'Destination account not found');
    }

    // Check and debit in one statement, in SQL, so no money value is ever
    // parsed into a JS number and no other transfer can act in between.
    const debit = await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1', [
      amount,
      fromAccountId,
    ]);
    if (debit.rowCount !== 1) {
      throw new HttpError(422, 'insufficient_funds', 'Source account has insufficient funds');
    }

    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toAccountId]);

    const { rows } = await client.query<Transfer>(
      `INSERT INTO transfers (from_account_id, to_account_id, amount, idempotency_key, initiated_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${TRANSFER_COLUMNS}`,
      [fromAccountId, toAccountId, amount, idempotencyKey, userId],
    );
    return { transfer: rows[0]!, replayed: false };
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
