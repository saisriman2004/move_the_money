import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { DomainEvent } from '../src/outbox';
import { startTestApp, type TestApp, type TestUser } from './helpers';

let app: TestApp;
let svc: typeof import('../src/webhooks/service.js');
let signing: typeof import('../src/webhooks/signing.js');
let urls: typeof import('../src/webhooks/urls.js');
let db: typeof import('../src/db/index.js');

// A fake customer endpoint whose responses each test scripts.
interface Received { at: number; headers: IncomingMessage['headers']; body: string }
let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
let respond: (n: number) => number | 'hang' = () => 200;

before(async () => {
  Object.assign(process.env, {
    WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
    WEBHOOK_TIMEOUT_MS: '300',
    WEBHOOK_MAX_ATTEMPTS: '3',
    WEBHOOK_RETRY_BASE_MS: '150',
  });
  app = await startTestApp({ isolatedDatabase: 'webhooks' });
  svc = await import('../src/webhooks/service.js');
  signing = await import('../src/webhooks/signing.js');
  urls = await import('../src/webhooks/urls.js');
  db = await import('../src/db/index.js');
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ at: Date.now(), headers: req.headers, body });
      const status = respond(received.length);
      if (status === 'hang') return; // never answers
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  receiverUrl = `http://localhost:${(receiver.address() as AddressInfo).port}/hook`;
});

after(async () => {
  receiver.closeAllConnections();
  await new Promise((resolve) => receiver.close(resolve));
  await app?.close();
});

beforeEach(async () => {
  received = [];
  respond = () => 200;
  // Every test starts with nothing left to deliver.
  await app.query("UPDATE webhook_deliveries SET status = 'dead' WHERE status = 'pending'");
});

const as = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(user: TestUser, events = ['transfer.completed'], url = receiverUrl) {
  const res = await app.request('POST', '/webhooks', { url, events }, as(user));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; secret: string };
}

function event(userIds: { from?: string; to?: string; user?: string }, type: DomainEvent['type'] = 'transfer.completed'): DomainEvent {
  return {
    id: randomUUID(),
    type,
    occurred_at: new Date().toISOString(),
    correlation_id: null,
    data: { transfer: { id: randomUUID(), amount: '5.00' }, from_user_id: userIds.from, to_user_id: userIds.to, user_id: userIds.user },
  };
}

async function fanOut(e: DomainEvent): Promise<number> {
  return db.withTransaction((client) => svc.fanOutEvent(e, client));
}

/** Runs the dispatcher until nothing is due or the deadline passes. */
async function dispatchUntilQuiet(ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await svc.dispatchDueDeliveries();
    await sleep(25);
  }
}

describe('managing webhooks', () => {
  test('creating one returns its secret once; listing never shows it', async () => {
    const user = await app.registerUser();
    const created = await register(user, ['transfer.completed', 'transfer.refunded']);
    assert.match(created.secret, /^whsec_[0-9a-f]{48}$/);
    const list = await app.request('GET', '/webhooks', undefined, as(user));
    assert.equal(list.body.data.length, 1);
    assert.ok(!('secret' in list.body.data[0]));
    assert.deepEqual(list.body.data[0].events, ['transfer.completed', 'transfer.refunded']);
  });

  for (const [label, body, code] of [
    ['a non-http URL', { url: 'ftp://example.com/x', events: ['transfer.completed'] }, 'invalid_url'],
    ['a relative URL', { url: '/hook', events: ['transfer.completed'] }, 'invalid_url'],
    ['an unknown event', { url: 'https://example.com/x', events: ['money.stolen'] }, 'invalid_events'],
    ['no events', { url: 'https://example.com/x', events: [] }, 'invalid_events'],
  ] as const) {
    test(`rejects ${label}`, async () => {
      const res = await app.request('POST', '/webhooks', body, as(await app.registerUser()));
      assert.equal(res.status, 400);
      assert.equal(res.body.error, code);
    });
  }

  test('private and local addresses are refused unless explicitly allowed', () => {
    for (const url of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.20.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x']) {
      assert.throws(() => urls.parseWebhookUrl(url, false), { code: 'invalid_url' }, url);
      assert.doesNotThrow(() => urls.parseWebhookUrl(url, true));
    }
    assert.doesNotThrow(() => urls.parseWebhookUrl('https://hooks.example.com/payments', false));
  });

  test("deleting deactivates it; someone else's webhook is 404", async () => {
    const [user, stranger] = [await app.registerUser(), await app.registerUser()];
    const { id } = await register(user);
    assert.equal((await app.request('DELETE', `/webhooks/${id}`, undefined, as(stranger))).status, 404);
    assert.equal((await app.request('GET', `/webhooks/${id}/deliveries`, undefined, as(stranger))).status, 404);
    assert.equal((await app.request('DELETE', `/webhooks/${id}`, undefined, as(user))).status, 204);
    assert.equal((await app.request('GET', '/webhooks', undefined, as(user))).body.data[0].active, false);
  });
});

describe('fan-out', () => {
  test('one delivery per subscribed, active endpoint of the users the event concerns', async () => {
    const [sender, receiverUser, bystander] = [await app.registerUser(), await app.registerUser(), await app.registerUser()];
    await register(sender, ['transfer.completed']);
    await register(receiverUser, ['transfer.completed']);
    await register(receiverUser, ['transfer.refunded']); // not subscribed to this type
    await register(bystander, ['transfer.completed']); // not involved
    const inactive = await register(sender, ['transfer.completed']);
    await app.request('DELETE', `/webhooks/${inactive.id}`, undefined, as(sender));

    assert.equal(await fanOut(event({ from: sender.id, to: receiverUser.id })), 2);
  });

  test('processing the same event twice creates no duplicate deliveries', async () => {
    const user = await app.registerUser();
    await register(user);
    const e = event({ from: user.id });
    assert.equal(await fanOut(e), 1);
    assert.equal(await fanOut(e), 0);
  });
});

describe('delivery', () => {
  test('POSTs the event with a valid signature and records success', async () => {
    const user = await app.registerUser();
    const { id, secret } = await register(user);
    const e = event({ from: user.id });
    await fanOut(e);
    await svc.dispatchDueDeliveries();

    assert.equal(received.length, 1);
    const { headers, body } = received[0]!;
    assert.equal(headers['webhook-event'], 'transfer.completed');
    assert.equal(headers['content-type'], 'application/json');
    assert.ok(signing.verifyWebhookSignature(secret, String(headers['webhook-signature']), body));
    assert.ok(!signing.verifyWebhookSignature('whsec_wrong', String(headers['webhook-signature']), body));
    assert.ok(!signing.verifyWebhookSignature(secret, String(headers['webhook-signature']), body.replace('5.00', '500.00')));
    assert.equal(JSON.parse(body).id, e.id);

    const deliveries = (await app.request('GET', `/webhooks/${id}/deliveries`, undefined, as(user))).body.data;
    assert.equal(deliveries[0].status, 'succeeded');
    assert.equal(deliveries[0].attempts, 1);
    assert.equal(deliveries[0].last_status_code, 200);
  });

  test('old signatures are rejected, so captured deliveries cannot be replayed later', () => {
    const header = signing.signWebhook('whsec_x', '{}', 1_000_000);
    assert.ok(signing.verifyWebhookSignature('whsec_x', header, '{}', 300, 1_000_100));
    assert.ok(!signing.verifyWebhookSignature('whsec_x', header, '{}', 300, 1_000_400));
  });

  test('a failing endpoint is retried with growing delays until it succeeds', async () => {
    const user = await app.registerUser();
    const { id } = await register(user);
    respond = (n) => (n < 3 ? 500 : 200);
    await fanOut(event({ from: user.id }));
    await dispatchUntilQuiet(2000);

    assert.equal(received.length, 3);
    const gap1 = received[1]!.at - received[0]!.at;
    const gap2 = received[2]!.at - received[1]!.at;
    assert.ok(gap1 >= 140, `first retry after ${gap1}ms`);
    assert.ok(gap2 >= 290, `second retry after ${gap2}ms`);
    const [delivery] = (await app.request('GET', `/webhooks/${id}/deliveries`, undefined, as(user))).body.data;
    assert.equal(delivery.status, 'succeeded');
    assert.equal(delivery.attempts, 3);
  });

  test('an endpoint that never answers times out, and after the last attempt the delivery is dead', async () => {
    const user = await app.registerUser();
    const { id } = await register(user);
    respond = () => 'hang';
    await fanOut(event({ from: user.id }));
    await dispatchUntilQuiet(3000);

    const [delivery] = (await app.request('GET', `/webhooks/${id}/deliveries`, undefined, as(user))).body.data;
    assert.equal(delivery.status, 'dead');
    assert.equal(delivery.attempts, 3);
    assert.equal(delivery.last_error, 'timed out after 300ms');
    assert.equal(received.length, 3);
  });

  test('redirects are not followed', async () => {
    const user = await app.registerUser();
    const { id } = await register(user);
    respond = () => 302;
    await fanOut(event({ from: user.id }));
    await svc.dispatchDueDeliveries();
    const [delivery] = (await app.request('GET', `/webhooks/${id}/deliveries`, undefined, as(user))).body.data;
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.last_status_code, 302);
  });

  test('concurrent dispatchers send each delivery exactly once', async () => {
    const user = await app.registerUser();
    await register(user);
    for (let i = 0; i < 15; i++) await fanOut(event({ from: user.id }));
    await Promise.all(Array.from({ length: 4 }, () => svc.dispatchDueDeliveries(3)));
    await Promise.all(Array.from({ length: 4 }, () => svc.dispatchDueDeliveries(3)));
    const ids = received.map((r) => r.headers['webhook-id']);
    assert.equal(ids.length, 15);
    assert.equal(new Set(ids).size, 15);
  });
});

describe('end to end through RabbitMQ', () => {
  test('a transfer reaches the receiver\'s webhook: API -> outbox -> broker -> fan-out -> HTTP', async () => {
    const prefix = `test.${process.pid}.${Date.now()}.`;
    const { RabbitPublisher } = await import('../src/messaging/publisher.js');
    const { EventConsumer } = await import('../src/messaging/consumer.js');
    const { relayOutboxBatch } = await import('../src/outbox-relay.js');
    const url = process.env.RABBITMQ_URL ?? 'amqp://mtm:mtm@localhost:5672';
    await relayOutboxBatch({ async publish() {} }, 100000); // only this test's events from here
    const publisher = await RabbitPublisher.connect(url, prefix);
    const consumer = await EventConsumer.start({
      name: 'webhooks', bindings: ['transfer.completed'], handler: async (e, c) => { await svc.fanOutEvent(e, c); },
      url, prefix, retryDelaysMs: [100], queueExpiresMs: 60_000,
    });
    try {
      const merchant = await app.registerUser();
      const { secret } = await register(merchant);
      const merchantAccount = await app.createEmptyAccount(merchant.id);
      const payer = await app.createAccount('50.00');
      const res = await app.request('POST', '/transfers', { from_account_id: payer, to_account_id: merchantAccount, amount: '12.00' }, { 'Idempotency-Key': randomUUID() });

      await relayOutboxBatch(publisher);
      const deadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < deadline) {
        await svc.dispatchDueDeliveries();
        await sleep(50);
      }
      assert.equal(received.length, 1);
      const body = JSON.parse(received[0]!.body);
      assert.equal(body.type, 'transfer.completed');
      assert.equal(body.data.transfer.id, res.body.id);
      assert.ok(signing.verifyWebhookSignature(secret, String(received[0]!.headers['webhook-signature']), received[0]!.body));
    } finally {
      await consumer.stop();
      await publisher.close();
      const { connect } = await import('amqplib');
      const admin = await connect(url);
      const channel = await admin.createChannel();
      for (const q of [consumer.topology.queue, ...consumer.topology.retryQueues, consumer.topology.deadLetterQueue]) await channel.deleteQueue(q);
      await channel.deleteExchange(`${prefix}events`);
      await admin.close();
    }
  });
});
