// Demo: the database connection dies in the middle of a transfer.
//
// Run with the API already running (npm run dev) in another terminal:
//   node scripts/crash-demo.js
//
// What it shows:
//   1. A transfer that has already debited Alice and credited Bob, but not committed yet,
//      is invisible to everyone else.
//   2. When its database connection is killed, Postgres throws the whole transaction away:
//      no money is lost or created, and the client gets a 500.
//   3. Retrying with the same Idempotency-Key runs the transfer once, and any further
//      retry replays it instead of moving money again.

const { Client } = require('pg');

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/move_money';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function createAccount(name, balance) {
  const res = await api('POST', '/accounts', { first_name: name, last_name: 'Demo', starting_balance: balance });
  return res.body.id;
}

(async () => {
  // "observer" plays a second user looking at the database; "blocker" is used to pause the transfer.
  const observer = new Client(DB);
  const blocker = new Client(DB);
  await observer.connect();
  await blocker.connect();

  async function balances(alice, bob) {
    const { rows } = await observer.query('SELECT id, balance FROM accounts WHERE id = ANY($1::uuid[])', [[alice, bob]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.balance]));
    return `Alice ${byId[alice]}, Bob ${byId[bob]}`;
  }

  const alice = await createAccount('Alice', '100.00');
  const bob = await createAccount('Bob', '10.00');
  const carol = await createAccount('Carol', '5.00');
  const dave = await createAccount('Dave', '5.00');
  const key = `crash-demo-${Date.now()}`;
  const transfer = { from_account_id: alice, to_account_id: bob, amount: '30.00' };
  console.log(`STEP 0  start:                                  ${await balances(alice, bob)}`);

  // How we pause the transfer at the worst possible moment: another session inserts an
  // UNCOMMITTED transfer (between Carol and Dave) that uses the same idempotency key.
  // Our transfer will debit Alice and credit Bob, then get stuck on its final INSERT,
  // waiting to see whether that other row with the same key commits.
  await blocker.query('BEGIN');
  await blocker.query(
    'INSERT INTO transfers (from_account_id, to_account_id, amount, idempotency_key) VALUES ($1, $2, 1, $3)',
    [carol, dave, key],
  );

  // Send the transfer, but don't wait for the answer yet: it's going to hang.
  const pending = api('POST', '/transfers', transfer, { 'Idempotency-Key': key });

  // Find the transfer's database connection while it's stuck waiting on that INSERT.
  let pid;
  for (let i = 0; i < 100 && !pid; i++) {
    const { rows } = await observer.query(
      `SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO transfers%' AND pid <> $1`,
      [blocker.processID],
    );
    pid = rows[0]?.pid;
    if (!pid) await sleep(20);
  }
  if (!pid) throw new Error('Transfer never got stuck; is the API running?');
  console.log(`STEP 1  transfer is mid-transaction (Postgres connection ${pid}): Alice already debited, Bob credited`);
  console.log(`        what everyone else sees right now:     ${await balances(alice, bob)}   <- uncommitted changes are invisible`);

  // The "database failure": kill that connection before it can COMMIT.
  await observer.query('SELECT pg_terminate_backend($1)', [pid]);
  const crashed = await pending;
  console.log(`STEP 2  connection killed -> client got:        ${crashed.status} ${JSON.stringify(crashed.body)}`);
  console.log(`        X-Request-Id: ${crashed.headers.get('x-request-id')}   (grep for it in logs/app.log)`);
  await blocker.query('ROLLBACK');

  const { rows: stored } = await observer.query('SELECT count(*) FROM transfers WHERE idempotency_key = $1', [key]);
  console.log(`STEP 3  after the crash:                        ${await balances(alice, bob)}, transfers with this key: ${stored[0].count}`);

  const retry = await api('POST', '/transfers', transfer, { 'Idempotency-Key': key });
  console.log(`STEP 4  client retries with the same key:       ${retry.status}, replayed: ${retry.headers.get('idempotent-replayed') ?? 'no'} -> ${await balances(alice, bob)}`);

  const again = await api('POST', '/transfers', transfer, { 'Idempotency-Key': key });
  console.log(`STEP 5  retries once more:                      ${again.status}, replayed: ${again.headers.get('idempotent-replayed') ?? 'no'}, same id: ${again.body.id === retry.body.id} -> ${await balances(alice, bob)}`);

  await observer.end();
  await blocker.end();
})().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
