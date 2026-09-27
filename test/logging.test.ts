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
  assert.equal(created.method, 'POST');
  assert.equal(created.status, 201);
  assert.equal(typeof created.duration_ms, 'number');

  const notFound = lines.find((l) => l.request_id === 'debug-me-123');
  assert.equal(notFound.level, 'warn');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.error_code, 'account_not_found');
});
