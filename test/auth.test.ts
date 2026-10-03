import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { startTestApp, TEST_JWT_SECRET, type TestApp, type TestUser } from './helpers';

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

const NO_AUTH = { authorization: '' };
const email = () => `auth-${randomUUID()}@example.test`;
const as = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });

describe('register and login', () => {
  test('register returns the user and a token, and stores only a password hash', async () => {
    const address = email();
    const res = await app.request('POST', '/auth/register', { email: address, password: 'longenough' }, NO_AUTH);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, address);
    assert.ok(!('password_hash' in res.body.user));
    assert.equal(typeof res.body.token, 'string');

    const [row] = await app.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [res.body.user.id]);
    assert.match(row!.password_hash, /^scrypt\$/);
    assert.ok(!row!.password_hash.includes('longenough'));
  });

  test('emails are unique regardless of case', async () => {
    const address = email();
    assert.equal((await app.request('POST', '/auth/register', { email: address, password: 'longenough' }, NO_AUTH)).status, 201);
    const again = await app.request('POST', '/auth/register', { email: address.toUpperCase(), password: 'longenough' }, NO_AUTH);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'email_taken');
  });

  for (const [label, body, code] of [
    ['an invalid email', { email: 'not-an-email', password: 'longenough' }, 'invalid_email'],
    ['a short password', { email: 'short@example.test', password: 'short' }, 'invalid_password'],
    ['an unknown field', { email: 'x@example.test', password: 'longenough', role: 'admin' }, 'unknown_field'],
  ] as const) {
    test(`register rejects ${label}`, async () => {
      const res = await app.request('POST', '/auth/register', body, NO_AUTH);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, code);
    });
  }

  test('login with the right password returns a working token', async () => {
    const address = email();
    await app.request('POST', '/auth/register', { email: address, password: 'longenough' }, NO_AUTH);
    const res = await app.request('POST', '/auth/login', { email: address.toUpperCase(), password: 'longenough' }, NO_AUTH);
    assert.equal(res.status, 200);
    const me = await app.request('GET', '/auth/me', undefined, { authorization: `Bearer ${res.body.token}` });
    assert.equal(me.status, 200);
    assert.equal(me.body.email, address);
  });

  test('a wrong password and an unknown email get the same 401', async () => {
    const address = email();
    await app.request('POST', '/auth/register', { email: address, password: 'longenough' }, NO_AUTH);
    const wrong = await app.request('POST', '/auth/login', { email: address, password: 'wrong-password' }, NO_AUTH);
    const unknown = await app.request('POST', '/auth/login', { email: email(), password: 'longenough' }, NO_AUTH);
    for (const res of [wrong, unknown]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: 'invalid_credentials', message: 'Email or password is incorrect' });
    }
  });
});

describe('tokens', () => {
  const secret = TEST_JWT_SECRET;

  test('a request without a token is rejected with 401', async () => {
    const res = await app.request('GET', '/accounts', undefined, NO_AUTH);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_token');
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  });

  for (const [label, token, message] of [
    ['an expired token', () => jwt.sign({}, secret, { subject: app.user.id, issuer: 'move-the-money', expiresIn: -10 }), 'Access token has expired'],
    ['a token signed with another secret', () => jwt.sign({}, 'x'.repeat(40), { subject: app.user.id, issuer: 'move-the-money' }), 'Access token is invalid'],
    ['an unsigned "alg: none" token', () => jwt.sign({ sub: app.user.id, iss: 'move-the-money' }, '', { algorithm: 'none' }), 'Access token is invalid'],
    ['garbage', () => 'not.a.token', 'Access token is invalid'],
  ] as const) {
    test(`${label} is rejected with 401`, async () => {
      const res = await app.request('GET', '/auth/me', undefined, { authorization: `Bearer ${token()}` });
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: 'invalid_token', message });
    });
  }

  test('health checks need no token', async () => {
    assert.equal((await app.request('GET', '/health', undefined, NO_AUTH)).status, 200);
  });
});

describe('account ownership', () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceAccount: string;
  let bobAccount: string;

  before(async () => {
    alice = await app.registerUser();
    bob = await app.registerUser();
    const open = async (user: TestUser) =>
      (await app.request('POST', '/accounts', { first_name: 'A', last_name: 'B', starting_balance: '100.00' }, as(user))).body.id;
    aliceAccount = await open(alice);
    bobAccount = await open(bob);
  });

  test('GET /accounts lists only your own accounts', async () => {
    const res = await app.request('GET', '/accounts', undefined, as(alice));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((a: { id: string }) => a.id), [aliceAccount]);
  });

  test("someone else's account, and its history, look like they don't exist", async () => {
    assert.equal((await app.request('GET', `/accounts/${bobAccount}`, undefined, as(alice))).status, 404);
    assert.equal((await app.request('GET', `/accounts/${bobAccount}/transactions`, undefined, as(alice))).status, 404);
  });

  test("you can't move money out of someone else's account", async () => {
    const res = await app.request(
      'POST',
      '/transfers',
      { from_account_id: bobAccount, to_account_id: aliceAccount, amount: '50.00' },
      { ...as(alice), 'Idempotency-Key': randomUUID() },
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'account_not_found', message: 'Source account not found' });
    assert.equal(await app.balance(bobAccount), '100.00');
  });

  test("you can pay into someone else's account", async () => {
    const res = await app.request(
      'POST',
      '/transfers',
      { from_account_id: aliceAccount, to_account_id: bobAccount, amount: '10.00' },
      { ...as(alice), 'Idempotency-Key': randomUUID() },
    );
    assert.equal(res.status, 201);
    assert.equal(await app.balance(bobAccount), '110.00');
  });

  test('an unauthenticated transfer is rejected and moves nothing', async () => {
    const before = await app.balance(aliceAccount);
    const res = await app.request(
      'POST',
      '/transfers',
      { from_account_id: aliceAccount, to_account_id: bobAccount, amount: '1.00' },
      { ...NO_AUTH, 'Idempotency-Key': randomUUID() },
    );
    assert.equal(res.status, 401);
    assert.equal(await app.balance(aliceAccount), before);
  });

  test('idempotency keys are scoped per user: the same key from two users makes two transfers', async () => {
    const key = randomUUID();
    const send = (user: TestUser, from: string, to: string) =>
      app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount: '1.00' }, { ...as(user), 'Idempotency-Key': key });
    const a = await send(alice, aliceAccount, bobAccount);
    const b = await send(bob, bobAccount, aliceAccount);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
    assert.equal(b.headers.get('idempotent-replayed'), null);
  });
});
