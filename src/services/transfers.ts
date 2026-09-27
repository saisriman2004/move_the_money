import { withTransaction } from '../db';
import { HttpError } from '../errors';

export interface Transfer {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  created_at: Date;
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  idempotencyKey?: string;
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
  fromAccountId,
  toAccountId,
  amount,
  idempotencyKey,
}: TransferInput): Promise<TransferResult> {
  return withTransaction(async (client) => {
    if (idempotencyKey !== undefined) {
      // Serialize requests sharing a key, before anything else, so a concurrent
      // retry waits for the first attempt to commit and then finds it below.
      // Catching a unique violation on insert instead would be too late: a retry
      // could fail with insufficient_funds before it ever reached the insert.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
      const { rows: existing } = await client.query<Transfer & { matches: boolean }>(
        `SELECT ${TRANSFER_COLUMNS},
                (from_account_id = $2 AND to_account_id = $3 AND amount = $4::numeric) AS matches
         FROM transfers WHERE idempotency_key = $1`,
        [idempotencyKey, fromAccountId, toAccountId, amount],
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
    }

    // Lock both accounts in a fixed (id) order. Without this, concurrent
    // transfers A->B and B->A can each lock one row and deadlock on the other.
    const { rows: locked } = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[fromAccountId, toAccountId]],
    );
    // Postgres returns ids lowercased, so compare against lowercased input.
    const lockedIds = new Set(locked.map((row) => row.id));
    if (!lockedIds.has(fromAccountId.toLowerCase())) {
      throw new HttpError(404, 'account_not_found', 'Source account not found');
    }
    if (!lockedIds.has(toAccountId.toLowerCase())) {
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
      `INSERT INTO transfers (from_account_id, to_account_id, amount, idempotency_key)
       VALUES ($1, $2, $3, $4)
       RETURNING ${TRANSFER_COLUMNS}`,
      [fromAccountId, toAccountId, amount, idempotencyKey ?? null],
    );
    return { transfer: rows[0]!, replayed: false };
  });
}
