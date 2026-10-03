import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

const APP_ORIGIN = 'https://app.example.com';
let app: TestApp;

before(async () => {
  Object.assign(process.env, { CORS_ORIGINS: `${APP_ORIGIN},http://localhost:5173`, TRUST_PROXY: '1', AUTH_RATE_LIMIT_PER_MINUTE: '3' });
  app = await startTestApp({ isolatedDatabase: 'gateway' });
});

after(async () => {
  await app.close();
});

const raw = (path: string, init: RequestInit = {}) => fetch(app.baseUrl + path, init);

describe('versioning', () => {
  test('the API lives under /api/v1; unversioned paths are gone; health checks stay at the root', async () => {
    assert.equal((await app.request('GET', '/api/v1/accounts')).status, 200);
    assert.equal((await app.request('GET', '/api/accounts')).status, 404);
    assert.equal((await raw('/accounts')).status, 404);
    assert.equal((await raw('/health')).status, 200);
    assert.equal((await raw('/api/v2/accounts')).status, 404);
  });
});

describe('request and correlation ids', () => {
  test('a caller-supplied correlation id is echoed and carried into the transfer event', async () => {
    const a = await app.createAccount('20.00');
    const b = await app.createEmptyAccount();
    const res = await app.request('POST', '/transfers', { from_account_id: a, to_account_id: b, amount: '1.00' }, { 'Idempotency-Key': randomUUID(), 'X-Correlation-Id': 'checkout-42' });
    assert.equal(res.headers.get('x-correlation-id'), 'checkout-42');
    assert.notEqual(res.headers.get('x-request-id'), 'checkout-42');
    const [event] = await app.query<{ correlation_id: string }>('SELECT correlation_id FROM outbox_events WHERE aggregate_id = $1', [res.body.id]);
    assert.equal(event!.correlation_id, 'checkout-42');
  });

  test('without one, the correlation id is the request id; unsafe values are replaced', async () => {
    const plain = await app.request('GET', '/accounts');
    assert.equal(plain.headers.get('x-correlation-id'), plain.headers.get('x-request-id'));
    const unsafe = await app.request('GET', '/accounts', undefined, { 'X-Correlation-Id': 'bad id with spaces' });
    assert.equal(unsafe.headers.get('x-correlation-id'), unsafe.headers.get('x-request-id'));
  });
});

describe('CORS', () => {
  test('a preflight from an allowed origin is answered before authentication', async () => {
    const res = await raw('/api/v1/transfers', {
      method: 'OPTIONS',
      headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, idempotency-key' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers')!, /Idempotency-Key/);
    assert.match(res.headers.get('access-control-allow-methods')!, /POST/);
  });

  test('an allowed origin can read error responses and the rate-limit headers', async () => {
    const res = await raw('/api/v1/accounts', { headers: { Origin: APP_ORIGIN } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.match(res.headers.get('access-control-expose-headers')!, /Retry-After/);
  });

  test('an unlisted origin gets no CORS headers', async () => {
    const preflight = await raw('/api/v1/transfers', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const res = await raw('/api/v1/accounts', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.match(res.headers.get('vary') ?? '', /Origin/);
  });
});

describe('security headers', () => {
  test('are set on every response, and X-Powered-By is not', async () => {
    for (const res of [await raw('/health'), await raw('/api/v1/nope')]) {
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-powered-by'), null);
    }
  });
});

describe('behind a proxy', () => {
  test('the per-IP login limit uses X-Forwarded-For when TRUST_PROXY is set', async () => {
    const login = (ip: string) =>
      raw('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email: 'x@example.test', password: 'wrong-password' }) });
    const one = [];
    for (let i = 0; i < 4; i++) one.push((await login('203.0.113.7')).status);
    assert.deepEqual(one, [401, 401, 401, 429]);
    assert.equal((await login('198.51.100.9')).status, 401);
  });
});
