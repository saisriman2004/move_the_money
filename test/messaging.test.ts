import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { connect, type ChannelModel, type GetMessage } from 'amqplib';
import type { PoolClient } from 'pg';
import type { DomainEvent } from '../src/outbox';
import { startTestApp, type TestApp } from './helpers';

const URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
// Unique per run, so parallel or repeated runs never share queues.
const PREFIX = `test.${process.pid}.${Date.now()}.`;
const RETRY_DELAYS = [100, 200];

let app: TestApp;
let relay: typeof import('../src/outbox-relay.js');
let messaging: {
  RabbitPublisher: typeof import('../src/messaging/publisher.js').RabbitPublisher;
  EventConsumer: typeof import('../src/messaging/consumer.js').EventConsumer;
};
let publisher: Awaited<ReturnType<typeof messaging.RabbitPublisher.connect>>;
let admin: ChannelModel;
const consumers: { stop(): Promise<void>; topology: { queue: string; retryQueues: string[]; deadLetterQueue: string } }[] = [];

before(async () => {
  app = await startTestApp({ isolatedDatabase: 'messaging' });
  relay = await import('../src/outbox-relay.js');
  messaging = {
    RabbitPublisher: (await import('../src/messaging/publisher.js')).RabbitPublisher,
    EventConsumer: (await import('../src/messaging/consumer.js')).EventConsumer,
  };
  publisher = await messaging.RabbitPublisher.connect(URL, PREFIX);
  admin = await connect(URL);
  await app.query('CREATE TABLE IF NOT EXISTS consumer_test_effects (event_id UUID, note TEXT)');
  // Start from an empty outbox so relay assertions only see this file's events.
  await relay.relayOutboxBatch({ async publish() {} }, 100000);
});

after(async () => {
  const channel = await admin.createChannel();
  for (const c of consumers) {
    await c.stop();
    for (const q of [c.topology.queue, ...c.topology.retryQueues, c.topology.deadLetterQueue]) await channel.deleteQueue(q);
  }
  await channel.deleteExchange(`${PREFIX}events`);
  await admin.close();
  await publisher.close();
  await app.close();
});

async function startConsumer(bindings: string[], handler: (event: DomainEvent, client: PoolClient) => Promise<void>) {
  const consumer = await messaging.EventConsumer.start({
    name: `c${consumers.length}-${randomUUID().slice(0, 8)}`,
    bindings,
    handler,
    url: URL,
    prefix: PREFIX,
    retryDelaysMs: RETRY_DELAYS,
    queueExpiresMs: 60_000,
  });
  consumers.push(consumer);
  return consumer;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fakeEvent(type = 'transfer.completed'): DomainEvent {
  return { id: randomUUID(), type: type as DomainEvent['type'], occurred_at: new Date().toISOString(), correlation_id: 'corr-1', data: { n: 1 } };
}

describe('outbox to RabbitMQ to consumer', () => {
  test('a committed transfer reaches a consumer through the relay, with its event id and correlation id', async () => {
    const received: DomainEvent[] = [];
    await startConsumer(['transfer.*'], async (event) => {
      received.push(event);
    });
    const a = await app.createAccount('20.00');
    const b = await app.createEmptyAccount();
    const res = await app.request('POST', '/transfers', { from_account_id: a, to_account_id: b, amount: '5.00' }, { 'Idempotency-Key': randomUUID(), 'X-Request-Id': 'corr-e2e' });

    await relay.relayOutboxBatch(publisher);
    await waitFor(() => received.some((e) => (e.data as any).transfer?.id === res.body.id));
    const event = received.find((e) => (e.data as any).transfer?.id === res.body.id)!;
    assert.equal(event.type, 'transfer.completed');
    assert.equal(event.correlation_id, 'corr-e2e');
    const [row] = await app.query<{ id: string; published_at: Date | null }>('SELECT id, published_at FROM outbox_events WHERE aggregate_id = $1', [res.body.id]);
    assert.equal(event.id, row!.id);
    assert.notEqual(row!.published_at, null);
  });

  test('consumers only receive the event types they are bound to', async () => {
    const received: string[] = [];
    await startConsumer(['account.created'], async (event) => {
      received.push(event.type);
    });
    await publisher.publish(fakeEvent('transfer.completed'));
    const created = fakeEvent('account.created');
    await publisher.publish(created);
    await waitFor(() => received.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(received, ['account.created']);
  });
});

describe('idempotent, retrying consumers', () => {
  test('the same event delivered twice is processed once', async () => {
    let calls = 0;
    const event = fakeEvent();
    const consumer = await startConsumer(['transfer.completed'], async (e, client) => {
      if (e.id !== event.id) return;
      calls++;
      await client.query("INSERT INTO consumer_test_effects (event_id, note) VALUES ($1, 'dup')", [e.id]);
    });
    await publisher.publish(event);
    await publisher.publish(event);
    // Other consumers in this file are bound to the same event type, so look only at this one.
    await waitFor(async () => (await app.query('SELECT 1 FROM processed_events WHERE consumer = $1 AND event_id = $2', [consumer.name, event.id])).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls, 1);
    assert.equal((await app.query('SELECT 1 FROM consumer_test_effects WHERE event_id = $1', [event.id])).length, 1);
  });

  test('a handler that fails twice is retried with delays and its writes land exactly once', async () => {
    const event = fakeEvent();
    const callTimes: number[] = [];
    await startConsumer(['transfer.completed'], async (e, client) => {
      if (e.id !== event.id) return;
      callTimes.push(Date.now());
      await client.query("INSERT INTO consumer_test_effects (event_id, note) VALUES ($1, 'retry')", [e.id]);
      if (callTimes.length < 3) throw new Error(`transient failure ${callTimes.length}`);
    });
    await publisher.publish(event);
    await waitFor(() => callTimes.length >= 3, 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(callTimes.length, 3);
    // Each retry waited at least its delay (100ms, then 200ms).
    assert.ok(callTimes[1]! - callTimes[0]! >= 90, `first retry after ${callTimes[1]! - callTimes[0]!}ms`);
    assert.ok(callTimes[2]! - callTimes[1]! >= 190, `second retry after ${callTimes[2]! - callTimes[1]!}ms`);
    // The failed attempts rolled back their writes.
    assert.equal((await app.query("SELECT 1 FROM consumer_test_effects WHERE event_id = $1 AND note = 'retry'", [event.id])).length, 1);
  });

  test('a handler that always fails ends up in the dead-letter queue with the attempt count and error', async () => {
    const event = fakeEvent();
    let calls = 0;
    const consumer = await startConsumer(['transfer.completed'], async (e) => {
      if (e.id !== event.id) return;
      calls++;
      throw new Error('downstream is broken');
    });
    await publisher.publish(event);
    const channel = await admin.createChannel();
    let msg: GetMessage | false = false;
    await waitFor(async () => {
      msg = await channel.get(consumer.topology.deadLetterQueue, { noAck: true });
      return msg !== false;
    }, 5000);
    await channel.close();
    if (!msg) throw new Error('no dead-lettered message');
    msg = msg as GetMessage;
    assert.equal(JSON.parse(msg.content.toString()).id, event.id);
    assert.equal(msg.properties.headers?.['x-attempt'], RETRY_DELAYS.length);
    assert.equal(msg.properties.headers?.['x-last-error'], 'downstream is broken');
    assert.equal(calls, RETRY_DELAYS.length + 1);
    assert.equal((await app.query('SELECT 1 FROM processed_events WHERE consumer = $1 AND event_id = $2', [consumer.name, event.id])).length, 0);
  });

  test('a malformed message goes straight to the dead-letter queue without calling the handler', async () => {
    let calls = 0;
    const consumer = await startConsumer(['transfer.completed'], async () => {
      calls++;
    });
    const channel = await admin.createChannel();
    channel.publish(`${PREFIX}events`, 'transfer.completed', Buffer.from('{not json'));
    let dead: GetMessage | false = false;
    await waitFor(async () => {
      dead = await channel.get(consumer.topology.deadLetterQueue, { noAck: true });
      return dead !== false;
    });
    await channel.close();
    assert.match(String((dead as unknown as GetMessage).properties.headers?.['x-last-error']), /malformed message/);
    assert.equal(calls, 0);
  });
});

describe('broker failures', () => {
  test('a connection error (e.g. a missed heartbeat) closes the publisher cleanly instead of crashing the process', async () => {
    const p = await messaging.RabbitPublisher.connect(URL, PREFIX);
    const closed = p.closed();
    // What amqplib does when heartbeats stop: emit 'error', then close.
    const connection = (p as unknown as { connection: import('events').EventEmitter & { close(): Promise<void> } }).connection;
    connection.emit('error', new Error('Heartbeat timeout'));
    await connection.close();
    await closed;
  });

  test('a connection error on a consumer closes it cleanly instead of crashing the process', async () => {
    const c = await startConsumer(['transfer.completed'], async () => {});
    const closed = (c as unknown as { closed(): Promise<void> }).closed();
    const connection = (c as unknown as { connection: import('events').EventEmitter & { close(): Promise<void> } }).connection;
    connection.emit('error', new Error('Heartbeat timeout'));
    await connection.close();
    await closed;
  });

  test('if the broker connection is gone, the relay leaves events pending to retry later', async () => {
    const broken = await messaging.RabbitPublisher.connect(URL, PREFIX);
    await broken.close();
    const a = await app.createAccount('5.00');
    const result = await relay.relayOutboxBatch(broken);
    assert.ok(result.failed >= 1);
    const [row] = await app.query<{ published_at: Date | null; attempts: number }>('SELECT published_at, attempts FROM outbox_events WHERE aggregate_id = $1', [a]);
    assert.equal(row!.published_at, null);
    assert.ok(row!.attempts >= 1);
    // A working publisher picks it up on the next batch.
    await relay.relayOutboxBatch(publisher);
    const [after] = await app.query<{ published_at: Date | null }>('SELECT published_at FROM outbox_events WHERE aggregate_id = $1', [a]);
    assert.notEqual(after!.published_at, null);
  });
});
