import { pool } from '../db';
import { HttpError } from '../errors';

export interface User {
  id: string;
  email: string;
  created_at: Date;
}

const USER_COLUMNS = 'id, email, created_at';

export async function createUser(email: string, passwordHash: string): Promise<User> {
  try {
    const { rows } = await pool.query<User>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING ${USER_COLUMNS}`,
      [email, passwordHash],
    );
    return rows[0]!;
  } catch (err) {
    // The unique index decides, so two simultaneous registrations can't both succeed.
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    }
    throw err;
  }
}

export async function findUserForLogin(email: string): Promise<(User & { password_hash: string }) | null> {
  const { rows } = await pool.query<User & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findUser(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
