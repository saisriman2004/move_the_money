// Load test against a running stack. Records every request's latency, so the
// percentiles are exact rather than estimated from a histogram.
//
//   BASE_URL=http://localhost:8080 DURATION_S=20 CONCURRENCY=32 npm run load-test
//
// The API's per-user rate limit and the risk velocity rule would (correctly) reject
// a load test, so start the stack with them relaxed (see docs/performance.md).
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const DURATION_MS = Number(process.env.DURATION_S ?? 20) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);

interface Result {
  scenario: string;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
}

async function call(method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Runs `request` from CONCURRENCY workers in a closed loop for DURATION_MS. */
async function run(scenario: string, request: () => Promise<number>): Promise<Result> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const deadline = Date.now() + DURATION_MS;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const t0 = performance.now();
        let status: string;
        try {
          status = String(await request());
        } catch {
          status = 'network_error';
        }
        latencies.push(performance.now() - t0);
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    scenario,
    requests: latencies.length,
    rps: Math.round(latencies.length / seconds),
    p50: round(percentile(latencies, 50)),
    p95: round(percentile(latencies, 95)),
    p99: round(percentile(latencies, 99)),
    max: round(latencies[latencies.length - 1]!),
    statuses,
  };
}

async function main() {
  const { body: user } = await call('POST', '/auth/register', '', { email: `load-${Date.now()}@example.com`, password: 'load-test-password' });
  const token: string = user.token;
  const accounts: string[] = [];
  for (let i = 0; i < 20; i++) {
    accounts.push((await call('POST', '/accounts', token, { first_name: 'Load', last_name: `T${i}`, starting_balance: '1000000.00' })).body.id);
  }
  const pick = () => accounts[Math.floor(Math.random() * accounts.length)]!;
  const transfer = (from: string, to: string) =>
    call('POST', '/transfers', token, { from_account_id: from, to_account_id: to, amount: '0.01' }, { 'Idempotency-Key': randomUUID() }).then((r) => r.status);

  console.log(`target ${BASE}, ${CONCURRENCY} concurrent clients, ${DURATION_MS / 1000}s per scenario\n`);
  const results: Result[] = [];

  results.push(await run('read: GET /accounts/:id (cached)', () => call('GET', `/accounts/${pick()}`, token).then((r) => r.status)));

  results.push(await run('write: transfers across 20 accounts', () => {
    const from = pick();
    let to = pick();
    while (to === from) to = pick();
    return transfer(from, to);
  }));

  // Every transfer locks the same source row, so they queue on it: the worst case.
  const [hot, ...others] = accounts;
  results.push(await run('write: hot account (all from one account)', () => transfer(hot!, others[Math.floor(Math.random() * others.length)]!)));

  console.table(results.map(({ statuses, ...r }) => ({ ...r, statuses: JSON.stringify(statuses) })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
