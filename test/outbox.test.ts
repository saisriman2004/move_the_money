import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { DomainEvent } from '../src/outbox';
import { startTestApp, type TestApp } from './helpers';

let app: TestApp;
let relay: typeof import('../src/outbox-relay.js');

before(async () => {
  // This file drains the whole outbox, so it gets a database of its own.
  app = await startTestApp({ isolatedDatabase: 'outbox' });
  relay = await import('../src/outbox-relay.js');
});

after(async () => {
  await app?.close();
});

/** Publishes nothing; just remembers what it was given. */
function recordingPublisher(failFor: (e: DomainEvent) => boolean = () => false) {
  const events: DomainEvent[] = [];
  return {
    events,
    async publish(event: DomainEvent) {
      if (failFor(event)) throw new Error(`broker unavailable for ${event.type}`);
      events.push(event);
    },
  };
}

function transfer(from: string, to: string, amount: string, key = randomUUID(), headers: Record<string, string> = {}) {
  return app.request('POST', '/transfers', { from_account_id: from, to_account_id: to, amount }, { 'Idempotency-Key': key, ...headers });
}

async function eventsFor(aggregateId: string) {
  return app.query<{ event_type: string; payload: any; correlation_id: string | null; published_at: Date | null }>(
    'SELECT event_type, payload, correlation_id, published_at FROM outbox_events WHERE aggregate_id = $1',
    [aggregateId],
  );
}

describe('writing events in the money transaction', () => {
  test('a transfer writes one transfer.completed event with both users and the request id', async () => {
    const other = await app.registerUser();
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount(other.id);
    const res = await transfer(a, b, '20.00', randomUUID(), { 'X-Request-Id': 'trace-me-1' });

    const events = await eventsFor(res.body.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event_type, 'transfer.completed');
    assert.equal(events[0]!.correlation_id, 'trace-me-1');
    assert.equal(events[0]!.published_at, null);
    assert.deepEqual(events[0]!.payload.transfer.id, res.body.id);
    assert.equal(events[0]!.payload.transfer.amount, '20.00');
    assert.equal(events[0]!.payload.from_user_id, app.user.id);
    assert.equal(events[0]!.payload.to_user_id, other.id);
  });

  test('a rejected transfer writes no event', async () => {
    const a = await app.createAccount('5.00');
    const b = await app.createEmptyAccount();
    const [before] = await app.query<{ n: string }>('SELECT count(*) AS n FROM outbox_events');
    assert.equal((await transfer(a, b, '9.00')).status, 422);
    const [after] = await app.query<{ n: string }>('SELECT count(*) AS n FROM outbox_events');
    assert.equal(after!.n, before!.n);
  });

  test('an event enqueued in a transaction that rolls back is never written', async () => {
    const { withTransaction } = await import('../src/db/index.js');
    const { enqueueEvent } = await import('../src/outbox.js');
    const aggregateId = randomUUID();
    await assert.rejects(
      withTransaction(async (client) => {
        await enqueueEvent(client, { type: 'transfer.completed', aggregateId, data: {} });
        throw new Error('money movement failed after the event was written');
      }),
      /money movement failed/,
    );
    assert.deepEqual(await eventsFor(aggregateId), []);
  });

  test('an idempotent replay writes no second event', async () => {
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount();
    const key = randomUUID();
    const first = await transfer(a, b, '1.00', key);
    await transfer(a, b, '1.00', key);
    assert.equal((await eventsFor(first.body.id)).length, 1);
  });

  test('opening an account writes account.created; a refund writes transfer.refunded', async () => {
    const payer = await app.registerUser();
    const a = await app.createAccount('30.00');
    assert.deepEqual((await eventsFor(a)).map((e) => e.event_type), ['account.created']);

    const payerAccount = (await app.request('POST', '/accounts', { first_name: 'P', last_name: 'Q', starting_balance: '10.00' }, { authorization: `Bearer ${payer.token}` })).body.id;
    const paid = await app.request('POST', '/transfers', { from_account_id: payerAccount, to_account_id: a, amount: '4.00' }, { authorization: `Bearer ${payer.token}`, 'Idempotency-Key': randomUUID() });
    const refund = await app.request('POST', `/transfers/${paid.body.id}/refund`, undefined, { 'Idempotency-Key': randomUUID() });
    const [event] = await eventsFor(refund.body.id);
    assert.equal(event!.event_type, 'transfer.refunded');
    assert.equal(event!.payload.original_transfer_id, paid.body.id);
    assert.equal(event!.payload.to_user_id, payer.id);
  });
});

describe('relaying events', () => {
  beforeEach(async () => {
    // Start each relay test from an empty backlog.
    await relay.relayOutboxBatch(recordingPublisher(), 100000);
  });

  test('publishes pending events oldest first, marks them published, and never publishes them again', async () => {
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount();
    const ids = [];
    for (const amount of ['1.00', '2.00', '3.00']) ids.push((await transfer(a, b, amount)).body.id);

    const publisher = recordingPublisher();
    const result = await relay.relayOutboxBatch(publisher);
    const transfers = publisher.events.filter((e) => e.type === 'transfer.completed');
    assert.deepEqual(transfers.map((e) => (e.data as any).transfer.id), ids);
    assert.ok(result.published >= 3);
    assert.ok(publisher.events.every((e) => typeof e.id === 'string' && !Number.isNaN(Date.parse(e.occurred_at))));

    const again = recordingPublisher();
    await relay.relayOutboxBatch(again);
    assert.deepEqual(again.events, []);
    for (const id of ids) assert.notEqual((await eventsFor(id))[0]!.published_at, null);
  });

  test('a failed publish leaves the event pending with the error, and the next batch retries it', async () => {
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount();
    const { id } = (await transfer(a, b, '1.00')).body;

    const failing = recordingPublisher((e) => e.type === 'transfer.completed');
    const first = await relay.relayOutboxBatch(failing);
    assert.equal(first.failed, 1);
    const [pending] = await app.query<{ attempts: number; last_error: string; published_at: Date | null }>(
      'SELECT attempts, last_error, published_at FROM outbox_events WHERE aggregate_id = $1',
      [id],
    );
    assert.equal(pending!.published_at, null);
    assert.equal(pending!.attempts, 1);
    assert.match(pending!.last_error, /broker unavailable/);

    const working = recordingPublisher();
    await relay.relayOutboxBatch(working);
    assert.ok(working.events.some((e) => (e.data as any).transfer?.id === id));
  });

  test('concurrent relays publish every event exactly once', async () => {
    const a = await app.createAccount('500.00');
    const b = await app.createEmptyAccount();
    await Promise.all(Array.from({ length: 40 }, () => transfer(a, b, '1.00')));

    const publishers = Array.from({ length: 4 }, () => recordingPublisher());
    // Small batches so the relays genuinely overlap.
    await Promise.all(publishers.map(async (p) => {
      for (let i = 0; i < 20; i++) await relay.relayOutboxBatch(p, 5);
    }));
    const all = publishers.flatMap((p) => p.events.map((e) => e.id));
    assert.ok(all.length >= 40);
    assert.equal(new Set(all).size, all.length, 'an event was published twice');
    assert.ok(publishers.filter((p) => p.events.length > 0).length > 1, 'only one relay did any work');
  });

  test('runRelay keeps publishing until it is stopped', async () => {
    const a = await app.createAccount('50.00');
    const b = await app.createEmptyAccount();
    const publisher = recordingPublisher();
    const controller = new AbortController();
    const running = relay.runRelay(publisher, { signal: controller.signal, idleMs: 20 });

    const { id } = (await transfer(a, b, '1.00')).body;
    for (let i = 0; i < 100 && !publisher.events.some((e) => (e.data as any).transfer?.id === id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await running;
    assert.ok(publisher.events.some((e) => (e.data as any).transfer?.id === id));
  });
});
