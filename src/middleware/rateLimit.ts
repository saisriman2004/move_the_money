import type { Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { HttpError } from '../errors';
import { logger } from '../logger';

// Sliding-window log, atomic in Redis: drop entries older than the window, count
// what's left, and add this request only if under the limit. Running it as one
// script means concurrent requests can't both see "one slot left".
const SLIDING_WINDOW = `
local key, now, window, limit, member = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, member)
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', key, window)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]
return { allowed, count, oldest or now }
`;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the oldest counted request leaves the window. */
  resetMs: number;
}

export function createRateLimiter(options: { redis: () => Redis; prefix: string; limit: number; windowMs: number }) {
  let sequence = 0;
  return async function check(key: string): Promise<RateLimitDecision> {
    const now = Date.now();
    const member = `${now}-${process.pid}-${sequence++}`;
    const [allowed, count, oldest] = (await options.redis().eval(
      SLIDING_WINDOW,
      1,
      `${options.prefix}rl:${key}`,
      now,
      options.windowMs,
      options.limit,
      member,
    )) as [number, number, string | number];
    return {
      allowed: allowed === 1,
      limit: options.limit,
      remaining: Math.max(0, options.limit - count),
      resetMs: Math.max(0, Number(oldest) + options.windowMs - now),
    };
  };
}

/**
 * Rejects requests over the limit with 429 and sets RateLimit-* headers.
 * If Redis is unreachable the request is allowed (fail-open): rate limiting
 * protects the service, and an outage of the limiter shouldn't become an outage of the API.
 */
export function rateLimit(
  check: (key: string) => Promise<RateLimitDecision>,
  keyFor: (req: Request, res: Response) => string,
): RequestHandler {
  return async (req, res, next) => {
    let decision: RateLimitDecision;
    try {
      decision = await check(keyFor(req, res));
    } catch (err) {
      logger.warn('rate limiter unavailable, allowing request', { error: (err as Error).message });
      next();
      return;
    }
    const resetSeconds = Math.ceil(decision.resetMs / 1000);
    res.set('RateLimit-Limit', String(decision.limit));
    res.set('RateLimit-Remaining', String(decision.remaining));
    res.set('RateLimit-Reset', String(resetSeconds));
    if (!decision.allowed) {
      res.set('Retry-After', String(Math.max(1, resetSeconds)));
      throw new HttpError(429, 'rate_limited', 'Too many requests; try again later');
    }
    next();
  };
}
