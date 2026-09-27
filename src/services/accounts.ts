import { pool } from '../db';

export interface Account {
  id: string;
  first_name: string;
  last_name: string;
  balance: string;
  created_at: Date;
}

const ACCOUNT_COLUMNS = 'id, first_name, last_name, balance, created_at';

export async function createAccount(input: { firstName: string; lastName: string; startingBalance: string }): Promise<Account> {
  const { rows } = await pool.query<Account>(
    `INSERT INTO accounts (first_name, last_name, balance) VALUES ($1, $2, $3) RETURNING ${ACCOUNT_COLUMNS}`,
    [input.firstName, input.lastName, input.startingBalance],
  );
  return rows[0]!;
}

export async function findAccount(id: string): Promise<Account | null> {
  const { rows } = await pool.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
