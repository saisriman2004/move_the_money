import { Redis } from 'ioredis';
import { config } from './config';

let client: Redis | undefined;

/**
 * The shared Redis client. Redis only holds rate-limit counters and cached reads,
 * never anything money depends on, so it is tuned to fail fast: no offline queue
 * and a short command timeout, letting callers fall back instead of stalling requests.
 */
export function redis(): Redis {
  client ??= new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    commandTimeout: 250,
    maxRetriesPerRequest: 1,
    // Keep trying to reconnect in the background, at most every 2 seconds.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  // Without a listener, a connection error would be an unhandled 'error' event.
  client.on('error', () => {});
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = undefined;
  await c.quit().catch(() => c.disconnect());
}
