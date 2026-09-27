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
}

const TRANSFER_COLUMNS = 'id, from_account_id, to_account_id, amount, created_at';

/**
 * Moves money between two accounts. The debit, the credit and the transfer
 * record commit together or not at all.
 */
export async function createTransfer({ fromAccountId, toAccountId, amount }: TransferInput): Promise<Transfer> {
  return withTransaction(async (client) => {
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
      `INSERT INTO transfers (from_account_id, to_account_id, amount)
       VALUES ($1, $2, $3)
       RETURNING ${TRANSFER_COLUMNS}`,
      [fromAccountId, toAccountId, amount],
    );
    return rows[0]!;
  });
}
