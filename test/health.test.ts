import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app?.close();
});

test('GET /health returns 200 without needing the database', async () => {
  const res = await app.request('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('GET /ready returns 200 when the database is reachable', async () => {
  const res = await app.request('GET', '/ready');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ready' });
});

test('GET /ready returns 503 when the database is unreachable, while /health stays 200', async () => {
  const { pool } = await import('../src/db/index.js');
  const down = mock.method(pool, 'query', async () => {
    throw new Error('connection refused');
  });
  try {
    const ready = await app.request('GET', '/ready');
    assert.equal(ready.status, 503);
    assert.deepEqual(ready.body, { error: 'not_ready', message: 'Database is unreachable' });
    assert.equal((await app.request('GET', '/health')).status, 200);
  } finally {
    down.mock.restore();
  }
});
