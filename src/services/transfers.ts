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
 *
 * Not yet safe under concurrency: the balance is read without a lock, so two
 * concurrent transfers can both pass the check before either debits.
 */
export async function createTransfer({ fromAccountId, toAccountId, amount }: TransferInput): Promise<Transfer> {
  return withTransaction(async (client) => {
    // Compared in SQL so no money value is ever parsed into a JS number.
    const { rows: source } = await client.query<{ sufficient: boolean }>(
      'SELECT balance >= $2::numeric AS sufficient FROM accounts WHERE id = $1',
      [fromAccountId, amount],
    );
    if (!source[0]) {
      throw new HttpError(404, 'account_not_found', 'Source account not found');
    }
    if (!source[0].sufficient) {
      throw new HttpError(422, 'insufficient_funds', 'Source account has insufficient funds');
    }

    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromAccountId]);

    const credit = await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toAccountId]);
    if (credit.rowCount !== 1) {
      // Throwing rolls back the debit above.
      throw new HttpError(404, 'account_not_found', 'Destination account not found');
    }

    const { rows } = await client.query<Transfer>(
      `INSERT INTO transfers (from_account_id, to_account_id, amount)
       VALUES ($1, $2, $3)
       RETURNING ${TRANSFER_COLUMNS}`,
      [fromAccountId, toAccountId, amount],
    );
    return rows[0]!;
  });
}
