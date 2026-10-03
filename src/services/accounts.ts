import { pool } from '../db';

export interface Account {
  id: string;
  first_name: string;
  last_name: string;
  balance: string;
  created_at: Date;
}

const ACCOUNT_COLUMNS = 'id, first_name, last_name, balance, created_at';

export async function createAccount(input: {
  userId: string;
  firstName: string;
  lastName: string;
  startingBalance: string;
}): Promise<Account> {
  const { rows } = await pool.query<Account>(
    `INSERT INTO accounts (user_id, first_name, last_name, balance) VALUES ($1, $2, $3, $4) RETURNING ${ACCOUNT_COLUMNS}`,
    [input.userId, input.firstName, input.lastName, input.startingBalance],
  );
  return rows[0]!;
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
