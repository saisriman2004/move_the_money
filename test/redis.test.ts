import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { startTestApp, type TestApp, type TestUser } from './helpers';

const WINDOW_MS = 1500;
let app: TestApp;
let limiter: typeof import('../src/middleware/rateLimit.js');

before(async () => {
  // Read when the app is imported; this file runs in its own process.
  process.env.RATE_LIMIT_PER_MINUTE = '5';
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '4';
  process.env.RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);
  process.env.ACCOUNT_CACHE_TTL_SECONDS = '1';
  app = await startTestApp(); // registers the default user: 1 of the 4 auth requests
  limiter = await import('../src/middleware/rateLimit.js');
});

after(async () => {
  await app?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const as = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });

describe('rate limiting', () => {
  // One user per test, so each starts with a fresh allowance.
  async function freshUser(): Promise<TestUser> {
    await sleep(WINDOW_MS + 100); // let the per-IP auth window drain first
    return app.registerUser();
  }

  test('allows the limit, then returns 429 with Retry-After and RateLimit headers', async () => {
    const user = await freshUser();
    const remaining: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request('GET', '/accounts', undefined, as(user));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('ratelimit-limit'), '5');
      remaining.push(res.headers.get('ratelimit-remaining')!);
    }
    assert.deepEqual(remaining, ['4', '3', '2', '1', '0']);

    const blocked = await app.request('GET', '/accounts', undefined, as(user));
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { error: 'rate_limited', message: 'Too many requests; try again later' });
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  });

  test('the window slides: requests are allowed again once old ones expire', async () => {
    const user = await freshUser();
    for (let i = 0; i < 5; i++) await app.request('GET', '/accounts', undefined, as(user));
    assert.equal((await app.request('GET', '/accounts', undefined, as(user))).status, 429);
    await sleep(WINDOW_MS + 100);
    assert.equal((await app.request('GET', '/accounts', undefined, as(user))).status, 200);
  });

  test('limits are per user: one user hitting the limit does not affect another', async () => {
    const [a, b] = [await freshUser(), await app.registerUser()];
    for (let i = 0; i < 6; i++) await app.request('GET', '/accounts', undefined, as(a));
    assert.equal((await app.request('GET', '/accounts', undefined, as(a))).status, 429);
    assert.equal((await app.request('GET', '/accounts', undefined, as(b))).status, 200);
  });

  test('20 concurrent requests against a limit of 5: exactly 5 are allowed', async () => {
    const user = await freshUser();
    const results = await Promise.all(Array.from({ length: 20 }, () => app.request('GET', '/accounts', undefined, as(user))));
    assert.equal(results.filter((r) => r.status === 200).length, 5);
    assert.equal(results.filter((r) => r.status === 429).length, 15);
  });

  test('login and register are limited per IP, so passwords cannot be guessed quickly', async () => {
    await sleep(WINDOW_MS + 100);
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.request('POST', '/auth/login', { email: 'victim@example.test', password: `guess-${i}` }, { authorization: '' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
  });

  test('if Redis is unreachable, the limiter fails open instead of failing the request', async () => {
    const dead = new Redis('redis://localhost:1', { enableOfflineQueue: false, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => {});
    const check = limiter.createRateLimiter({ redis: () => dead, prefix: 'x:', limit: 1, windowMs: 1000 });
    let nextCalled = false;
    const res = { set() { return res; } };
    await limiter.rateLimit(check, () => 'k')({} as never, res as never, () => { nextCalled = true; });
    assert.ok(nextCalled);
    dead.disconnect();
  });
});

describe('account cache', () => {
  let owner: TestUser;
  let accountId: string;

  before(async () => {
    await sleep(WINDOW_MS + 100);
    owner = await app.registerUser();
    accountId = (await app.request('POST', '/accounts', { first_name: 'C', last_name: 'A', starting_balance: '100.00' }, as(owner))).body.id;
  });

  const get = (user = owner) => app.request('GET', `/accounts/${accountId}`, undefined, as(user));

  test('the first read misses, the second is served from the cache', async () => {
    await sleep(WINDOW_MS + 100);
    const first = await get();
    const second = await get();
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.deepEqual(second.body, first.body);
    assert.ok(!('user_id' in second.body));
  });

  test("a transfer invalidates both accounts' cached balances", async () => {
    await sleep(WINDOW_MS + 100);
    await get();
    assert.equal((await get()).headers.get('x-cache'), 'HIT');
    const other = await app.createEmptyAccount(owner.id);
    const res = await app.request('POST', '/transfers', { from_account_id: accountId, to_account_id: other, amount: '30.00' }, { ...as(owner), 'Idempotency-Key': randomUUID() });
    assert.equal(res.status, 201);
    const after = await get();
    assert.equal(after.headers.get('x-cache'), 'MISS');
    assert.equal(after.body.balance, '70.00');
  });

  test("a cached account is still someone else's: a stranger gets 404", async () => {
    await sleep(WINDOW_MS + 100);
    await get();
    const stranger = await app.registerUser();
    assert.equal((await get(stranger)).status, 404);
  });

  test('cache entries expire after the TTL', async () => {
    await sleep(WINDOW_MS + 100);
    await get();
    assert.equal((await get()).headers.get('x-cache'), 'HIT');
    await sleep(1100);
    assert.equal((await get()).headers.get('x-cache'), 'MISS');
  });
});
