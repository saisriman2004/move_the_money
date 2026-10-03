import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;
let metrics: typeof import('../src/metrics.js');

before(async () => {
  process.env.METRICS_TOKEN = 'scrape-secret';
  app = await startTestApp({ isolatedDatabase: 'metrics' });
  metrics = await import('../src/metrics.js');
});

after(async () => {
  await app?.close();
});

async function scrape(): Promise<string> {
  const res = await fetch(`${app.baseUrl}/metrics`, { headers: { authorization: 'Bearer scrape-secret' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/plain/);
  return res.text();
}

/** The value of one sample, e.g. value(text, 'transfers_total{outcome="completed"}'). */
function value(text: string, sample: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${sample} `));
  return line ? Number(line.split(' ').pop()) : 0;
}

describe('GET /metrics', () => {
  test('requires the metrics token when one is configured', async () => {
    assert.equal((await fetch(`${app.baseUrl}/metrics`)).status, 401);
    assert.equal((await fetch(`${app.baseUrl}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  });

  test('counts transfers by outcome, errors by code, and requests by route template', async () => {
    const before = await scrape();
    const a = await app.createAccount('10.00');
    const b = await app.createEmptyAccount();
    const send = (amount: string) => app.request('POST', '/transfers', { from_account_id: a, to_account_id: b, amount }, { 'Idempotency-Key': randomUUID() });
    await send('1.00');
    await send('500.00'); // insufficient funds
    await app.request('GET', `/accounts/${a}`);
    const after = await scrape();

    assert.equal(value(after, 'transfers_total{outcome="completed"}') - value(before, 'transfers_total{outcome="completed"}'), 1);
    assert.equal(value(after, 'transfers_total{outcome="insufficient_funds"}') - value(before, 'transfers_total{outcome="insufficient_funds"}'), 1);
    assert.equal(value(after, 'api_errors_total{code="insufficient_funds",status="422"}') - value(before, 'api_errors_total{code="insufficient_funds",status="422"}'), 1);
    assert.ok(value(after, 'http_requests_total{method="GET",route="/api/v1/accounts/:id",status="200"}') >= 1);
    assert.match(after, /http_request_duration_seconds_bucket\{le="0.1",method="POST",route="\/api\/v1\/transfers"\}/);
  });

  test('ids never appear in labels, so the number of series stays bounded', async () => {
    await app.request('GET', `/accounts/${randomUUID()}`);
    await app.request('GET', `/nope/${randomUUID()}`);
    const text = await scrape();
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    assert.ok(value(text, 'http_requests_total{method="GET",route="unmatched",status="404"}') >= 1);
  });

  test('reports the outbox backlog read from the database at scrape time', async () => {
    const a = await app.createAccount('5.00');
    await app.request('POST', '/transfers', { from_account_id: a, to_account_id: await app.createEmptyAccount(), amount: '1.00' }, { 'Idempotency-Key': randomUUID() });
    const [row] = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
    const text = await scrape();
    assert.equal(value(text, 'outbox_pending_events'), row!.n);
    assert.ok(value(text, 'outbox_oldest_pending_age_seconds') >= 0);
    assert.match(text, /process_cpu_user_seconds_total/);
  });
});

describe('worker metrics server', () => {
  test('serves /metrics and /health, and 404 for anything else', async () => {
    const server = metrics.startMetricsServer(0, 'test-worker');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      assert.match(await (await fetch(`${base}/metrics`)).text(), /outbox_events_published_total/);
      assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', service: 'test-worker' });
      assert.equal((await fetch(`${base}/other`)).status, 404);
    } finally {
      server.close();
    }
  });
});
