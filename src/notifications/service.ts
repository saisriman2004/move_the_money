import type { PoolClient } from 'pg';
import { pool } from '../db';
import type { DomainEvent } from '../outbox';

interface Draft {
  userId: string;
  message: string;
  data: Record<string, unknown>;
}

interface TransferData {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  fee: string;
  risk_decision?: string | null;
}

/** "acc …1a2b": enough of an account id to recognise it in a message. */
const short = (id: string) => `…${id.slice(-4)}`;

/** Builds the messages an event produces, one per user it concerns. */
export function draftNotifications(event: DomainEvent): Draft[] {
  if (event.type === 'account.created') {
    const { account, user_id } = event.data as { account: { id: string; balance: string }; user_id: string };
    return [{ userId: user_id, message: `Account ${short(account.id)} opened with ${account.balance}.`, data: { account_id: account.id } }];
  }

  if (event.type === 'transfer.completed') {
    const { transfer: t, from_user_id, to_user_id } = event.data as { transfer: TransferData; from_user_id: string; to_user_id: string | null };
    const data = { transfer_id: t.id };
    const fee = /^0+(\.0+)?$/.test(t.fee) ? '' : ` (fee ${t.fee})`;
    const review = t.risk_decision === 'review' ? ' It has been flagged for review.' : '';
    if (from_user_id === to_user_id) {
      return [{ userId: from_user_id, message: `You moved ${t.amount} from ${short(t.from_account_id)} to ${short(t.to_account_id)}${fee}.${review}`, data }];
    }
    const drafts: Draft[] = [
      { userId: from_user_id, message: `You sent ${t.amount} to ${short(t.to_account_id)}${fee}.${review}`, data },
    ];
    if (to_user_id) drafts.push({ userId: to_user_id, message: `You received ${t.amount} from ${short(t.from_account_id)}.`, data });
    return drafts;
  }

  if (event.type === 'transfer.refunded') {
    const { refund, original_transfer_id, from_user_id, to_user_id } = event.data as {
      refund: TransferData;
      original_transfer_id: string;
      from_user_id: string;
      to_user_id: string | null;
    };
    const data = { transfer_id: refund.id, original_transfer_id };
    const drafts: Draft[] = [{ userId: from_user_id, message: `You refunded ${refund.amount} to ${short(refund.to_account_id)}.`, data }];
    if (to_user_id && to_user_id !== from_user_id) {
      drafts.push({ userId: to_user_id, message: `You were refunded ${refund.amount} by ${short(refund.from_account_id)}.`, data });
    }
    return drafts;
  }

  return [];
}

/** Event consumer handler. Idempotent through the (user_id, event_id) unique constraint. */
export async function notifyFromEvent(event: DomainEvent, client: PoolClient): Promise<number> {
  let created = 0;
  for (const draft of draftNotifications(event)) {
    const { rowCount } = await client.query(
      `INSERT INTO notifications (user_id, event_id, type, message, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT notifications_once DO NOTHING`,
      [draft.userId, event.id, event.type, draft.message, JSON.stringify(draft.data)],
    );
    created += rowCount ?? 0;
  }
  return created;
}

export interface Notification {
  id: string;
  type: string;
  message: string;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export async function listNotifications(userId: string, options: { unreadOnly: boolean; limit: number }) {
  const { rows } = await pool.query<Notification>(
    `SELECT id, type, message, data, read_at, created_at FROM notifications
      WHERE user_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [userId, options.unreadOnly, options.limit],
  );
  const { rows: count } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return { data: rows, unread_count: count[0]!.n };
}

export async function markRead(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rowCount === 1;
}

export async function markAllRead(userId: string): Promise<void> {
  await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
}
