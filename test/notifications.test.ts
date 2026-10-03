import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { DomainEvent } from '../src/outbox';
import { startTestApp, type TestApp, type TestUser } from './helpers';

let app: TestApp;
let svc: typeof import('../src/notifications/service.js');
let db: typeof import('../src/db/index.js');

before(async () => {
  app = await startTestApp({ isolatedDatabase: 'notifications' });
  svc = await import('../src/notifications/service.js');
  db = await import('../src/db/index.js');
});

after(async () => {
  await app.close();
});

const as = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });
const A = '11111111-0000-4000-8000-00000000aaaa';
const B = '22222222-0000-4000-8000-00000000bbbb';

function transferEvent(from: string, to: string | null, over: Record<string, unknown> = {}): DomainEvent {
  return {
    id: randomUUID(),
    type: 'transfer.completed',
    occurred_at: new Date().toISOString(),
    correlation_id: null,
    data: { transfer: { id: randomUUID(), from_account_id: A, to_account_id: B, amount: '12.50', fee: '0.13', risk_decision: 'approve', ...over }, from_user_id: from, to_user_id: to },
  };
}

const notify = (e: DomainEvent) => db.withTransaction((client) => svc.notifyFromEvent(e, client));

describe('message drafting', () => {
  test('a transfer tells the sender (with the fee) and the receiver', () => {
    assert.deepEqual(
      svc.draftNotifications(transferEvent('u1', 'u2')).map((d) => [d.userId, d.message]),
      [['u1', 'You sent 12.50 to …bbbb (fee 0.13).'], ['u2', 'You received 12.50 from …aaaa.']],
    );
  });

  test('no fee is mentioned when there is none, and a review flag is', () => {
    const [sender] = svc.draftNotifications(transferEvent('u1', 'u2', { fee: '0.00', risk_decision: 'review' }));
    assert.equal(sender!.message, 'You sent 12.50 to …bbbb. It has been flagged for review.');
  });

  test('a transfer between your own accounts is one notification', () => {
    const drafts = svc.draftNotifications(transferEvent('u1', 'u1'));
    assert.deepEqual(drafts.map((d) => d.message), ['You moved 12.50 from …aaaa to …bbbb (fee 0.13).']);
  });

  test('refunds and account openings', () => {
    const refund: DomainEvent = { id: randomUUID(), type: 'transfer.refunded', occurred_at: '', correlation_id: null, data: { refund: { id: 'r', from_account_id: B, to_account_id: A, amount: '12.50', fee: '0.00' }, original_transfer_id: 't', from_user_id: 'u2', to_user_id: 'u1' } };
    assert.deepEqual(svc.draftNotifications(refund).map((d) => [d.userId, d.message]), [['u2', 'You refunded 12.50 to …aaaa.'], ['u1', 'You were refunded 12.50 by …bbbb.']]);
    const opened: DomainEvent = { id: randomUUID(), type: 'account.created', occurred_at: '', correlation_id: null, data: { account: { id: A, balance: '40.00' }, user_id: 'u1' } };
    assert.deepEqual(svc.draftNotifications(opened).map((d) => d.message), ['Account …aaaa opened with 40.00.']);
  });
});

describe('storing and reading notifications', () => {
  test('processing an event twice stores one notification per user', async () => {
    const [u1, u2] = [await app.registerUser(), await app.registerUser()];
    const e = transferEvent(u1.id, u2.id);
    assert.equal(await notify(e), 2);
    assert.equal(await notify(e), 0);
  });

  test('users see only their own notifications, newest first, with an unread count', async () => {
    const [u1, u2] = [await app.registerUser(), await app.registerUser()];
    await notify(transferEvent(u1.id, u2.id, { amount: '1.00' }));
    await notify(transferEvent(u1.id, u2.id, { amount: '2.00' }));
    const res = await app.request('GET', '/notifications', undefined, as(u2));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((n: { message: string }) => n.message), ['You received 2.00 from …aaaa.', 'You received 1.00 from …aaaa.']);
    assert.equal(res.body.unread_count, 2);
  });

  test('marking one read, then all read', async () => {
    const [u1, u2] = [await app.registerUser(), await app.registerUser()];
    await notify(transferEvent(u1.id, u2.id));
    await notify(transferEvent(u1.id, u2.id));
    const [first] = (await app.request('GET', '/notifications', undefined, as(u2))).body.data;
    assert.equal((await app.request('POST', `/notifications/${first.id}/read`, undefined, as(u2))).status, 204);
    const afterOne = (await app.request('GET', '/notifications?unread=true', undefined, as(u2))).body;
    assert.equal(afterOne.unread_count, 1);
    assert.equal(afterOne.data.length, 1);
    assert.equal((await app.request('POST', '/notifications/read-all', undefined, as(u2))).status, 204);
    assert.equal((await app.request('GET', '/notifications', undefined, as(u2))).body.unread_count, 0);
  });

  test("someone else's notification can't be marked read", async () => {
    const [u1, u2] = [await app.registerUser(), await app.registerUser()];
    await notify(transferEvent(u1.id, u2.id));
    const [theirs] = (await app.request('GET', '/notifications', undefined, as(u2))).body.data;
    assert.equal((await app.request('POST', `/notifications/${theirs.id}/read`, undefined, as(u1))).status, 404);
  });

  test('rejects a bad unread filter or limit', async () => {
    assert.equal((await app.request('GET', '/notifications?unread=yes')).status, 400);
    assert.equal((await app.request('GET', '/notifications?limit=0')).status, 400);
  });
});

describe('end to end through RabbitMQ', () => {
  test('a real transfer produces notifications for both users', async () => {
    const prefix = `test.${process.pid}.${Date.now()}.`;
    const url = process.env.RABBITMQ_URL ?? 'amqp://mtm:mtm@localhost:5672';
    const { RabbitPublisher } = await import('../src/messaging/publisher.js');
    const { EventConsumer } = await import('../src/messaging/consumer.js');
    const { relayOutboxBatch } = await import('../src/outbox-relay.js');
    await relayOutboxBatch({ async publish() {} }, 100000);
    const publisher = await RabbitPublisher.connect(url, prefix);
    const consumer = await EventConsumer.start({
      name: 'notifications', bindings: ['transfer.completed'], handler: async (e, c) => { await svc.notifyFromEvent(e, c); },
      url, prefix, retryDelaysMs: [100], queueExpiresMs: 60_000,
    });
    try {
      const recipient = await app.registerUser();
      const to = await app.createEmptyAccount(recipient.id);
      const from = await app.createAccount('30.00');
      await app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount: '7.25' }, { 'Idempotency-Key': randomUUID() });
      await relayOutboxBatch(publisher);

      let mine: { message: string }[] = [];
      for (let i = 0; i < 100 && mine.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        mine = (await app.request('GET', '/notifications', undefined, as(recipient))).body.data;
      }
      assert.equal(mine.length, 1);
      assert.match(mine[0]!.message, /^You received 7\.25 from …/);
      const senders = (await app.request('GET', '/notifications')).body.data.map((n: { message: string }) => n.message);
      assert.ok(senders.some((m: string) => m.startsWith('You sent 7.25 to …')));
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
