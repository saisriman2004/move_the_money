import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { MISSING_ID, startTestApp, type TestApp } from './helpers';

const logFile = path.join(mkdtempSync(path.join(tmpdir(), 'move-money-logs-')), 'app.log');
let app: TestApp;

before(async () => {
  // Set before the app is imported, so the logger picks them up.
  process.env.LOG_LEVEL = 'info';
  process.env.LOG_FILE = logFile;
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

test('each request is written to the log file with its id, status and error code', async () => {
  const ok = await app.request('POST', '/accounts', { first_name: 'Ada', last_name: 'L', starting_balance: '1.00' });
  const rejected = await app.request('GET', `/accounts/${MISSING_ID}`, undefined, { 'X-Request-Id': 'debug-me-123' });
  await sleep(50); // the file stream writes asynchronously

  assert.match(ok.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/);
  assert.equal(rejected.headers.get('x-request-id'), 'debug-me-123');

  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const created = lines.find((l) => l.request_id === ok.headers.get('x-request-id'));
  assert.equal(created.level, 'info');
  assert.equal(created.service, 'api');
  assert.equal(created.method, 'POST');
  assert.equal(created.status, 201);
  assert.equal(typeof created.duration_ms, 'number');

  const notFound = lines.find((l) => l.request_id === 'debug-me-123');
  assert.equal(notFound.level, 'warn');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.error_code, 'account_not_found');
});

test('logs never contain the request body or the idempotency key', async () => {
  const { errorHandler } = await import('../src/middleware/errorHandler.js');

  // A request that reaches the log as a 400, carrying a key and a body.
  await app.request(
    'POST',
    '/transfers',
    { from_account_id: 'not-a-uuid', to_account_id: 'x', amount: '123.45' },
    { 'Idempotency-Key': 'secret-key-xyz', 'X-Request-Id': 'no-payload-400' },
  );

  // An unexpected 500, driven through the error handler directly.
  const res = {
    locals: { requestId: 'no-payload-500' },
    status() { return res; },
    json() { return res; },
  };
  const req = { method: 'POST', originalUrl: '/transfers', body: { from_account_id: 'acct-secret', amount: '987.65' } };
  errorHandler(new Error('boom'), req as never, res as never, () => {});
  await sleep(50);

  const text = readFileSync(logFile, 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  const unhandled = lines.find((l) => l.request_id === 'no-payload-500');
  assert.equal(unhandled.msg, 'unhandled error');
  assert.equal(unhandled.error, 'boom');
  assert.ok(!('body' in unhandled));
  assert.ok(lines.some((l) => l.request_id === 'no-payload-400' && l.status === 400));
  for (const secret of ['acct-secret', '987.65', '123.45', 'secret-key-xyz']) {
    assert.ok(!text.includes(secret), `log file contains ${secret}`);
  }
});
