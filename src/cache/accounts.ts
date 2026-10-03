import { config } from '../config';
import { logger } from '../logger';
import { redis } from '../redis';
import type { Account } from '../services/accounts';

/** What's cached: the account plus its owner, so the ownership check still applies to hits. */
export type CachedAccount = Account & { user_id: string };

const key = (id: string) => `${config.redisPrefix}account:${id.toLowerCase()}`;

/**
 * Cache-aside for account reads. Redis is never the source of truth: transfers
 * read and lock balances in PostgreSQL, and every balance change deletes the
 * entry after it commits. Any Redis failure falls through to the database.
 */
export async function getCachedAccount(id: string): Promise<CachedAccount | null> {
  try {
    const raw = await redis().get(key(id));
    return raw ? (JSON.parse(raw) as CachedAccount) : null;
  } catch (err) {
    logger.warn('account cache read failed', { error: (err as Error).message });
    return null;
  }
}

export async function cacheAccount(account: CachedAccount): Promise<void> {
  try {
    await redis().set(key(account.id), JSON.stringify(account), 'EX', config.accountCacheTtlSeconds);
  } catch (err) {
    logger.warn('account cache write failed', { error: (err as Error).message });
  }
}

/** Called after a transaction that changed these balances has committed. */
export async function invalidateAccounts(ids: string[]): Promise<void> {
  try {
    await redis().del(...ids.map(key));
  } catch (err) {
    // The entry expires on its own within the TTL.
    logger.warn('account cache invalidation failed', { error: (err as Error).message });
  }
}
