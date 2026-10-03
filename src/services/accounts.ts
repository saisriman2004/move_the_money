import { pool, withTransaction } from '../db';
import { postLedgerEntries, SYSTEM_ACCOUNTS } from '../ledger';

export interface Account {
  id: string;
  first_name: string;
  last_name: string;
  balance: string;
  created_at: Date;
}

const ACCOUNT_COLUMNS = 'id, first_name, last_name, balance, created_at';

/**
 * Opens an account. The starting balance is a deposit from the funding account,
 * so the money's origin is recorded in the ledger like any other movement.
 */
export async function createAccount(input: {
  userId: string;
  firstName: string;
  lastName: string;
  startingBalance: string;
}): Promise<Account> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<Account>(
      `INSERT INTO accounts (user_id, first_name, last_name, balance) VALUES ($1, $2, $3, $4) RETURNING ${ACCOUNT_COLUMNS}`,
      [input.userId, input.firstName, input.lastName, input.startingBalance],
    );
    const account = rows[0]!;
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [
      input.startingBalance,
      SYSTEM_ACCOUNTS.funding,
    ]);
    const { rows: deposit } = await client.query<{ id: string }>(
      `INSERT INTO transfers (kind, from_account_id, to_account_id, amount, initiated_by)
       VALUES ('deposit', $1, $2, $3, $4) RETURNING id`,
      [SYSTEM_ACCOUNTS.funding, account.id, input.startingBalance, input.userId],
    );
    await postLedgerEntries(client, deposit[0]!.id, [
      { accountId: SYSTEM_ACCOUNTS.funding, direction: 'debit', amount: input.startingBalance },
      { accountId: account.id, direction: 'credit', amount: input.startingBalance },
    ]);
    return account;
  });
}

/** Finds an account only if it belongs to the user; someone else's account looks missing. */
export async function findOwnedAccount(id: string, userId: string): Promise<Account | null> {
  const { rows } = await pool.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  return rows[0] ?? null;
}

export async function listOwnedAccounts(userId: string): Promise<Account[]> {
  const { rows } = await pool.query<Account>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return rows;
}
