import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

describe('API error handling', () => {
  test('a non-JSON body returns 415 instead of being silently ignored', async () => {
    const res = await fetch(`${app.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Ada&last_name=Lovelace&starting_balance=100.00',
    });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), {
      error: 'unsupported_media_type',
      message: 'Request body must be JSON (Content-Type: application/json)',
    });
  });

  test('an empty body with no Content-Type (as some proxies forward a body-less POST) is not a 415', async () => {
    // Chunked encoding with no data and no Content-Type: what a dev proxy sends for fetch(url, { method: 'POST' }).
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${app.baseUrl}/api/v1/notifications/read-all`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.user.token}`, 'transfer-encoding': 'chunked' },
      }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 204);
  });

  test('an unknown route returns a JSON 404 with a message', async () => {
    const res = await app.request('GET', '/nope');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found', message: 'No route for GET /api/v1/nope' });
  });

  test('a wrong method on a known route returns 405 with an Allow header', async () => {
    const res = await app.request('DELETE', '/accounts/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(res.body, { error: 'method_not_allowed', message: 'Method not allowed. Allowed: GET, HEAD' });
  });
});
