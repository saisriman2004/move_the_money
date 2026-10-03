import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db';
import { logger } from '../logger';
import type { DomainEvent } from '../outbox';
import { assertConsumerTopology, consumerTopology, type ConsumerTopology } from './topology';

export type EventHandler = (event: DomainEvent, client: PoolClient) => Promise<void>;

export interface ConsumerOptions {
  /** Identifies the consumer: names its queues and its rows in processed_events. */
  name: string;
  /** Event types (or topic patterns such as "transfer.*") to receive. */
  bindings: string[];
  /** Runs inside a database transaction; throw to retry the message. */
  handler: EventHandler;
  url: string;
  prefix: string;
  retryDelaysMs: number[];
  prefetch?: number;
  /** For tests: remove the queues automatically once unused. */
  queueExpiresMs?: number;
}

const ATTEMPT_HEADER = 'x-attempt';
const ERROR_HEADER = 'x-last-error';

/**
 * Consumes events with at-least-once delivery and makes processing idempotent.
 *
 * Each event's id is recorded in processed_events in the same transaction as the
 * handler's own writes. A redelivered event finds its row and is acknowledged
 * without running the handler again.
 *
 * A failing message is re-published to the next delay queue (1s, 5s, 25s by
 * default) and comes back afterwards; once the delays are used up it goes to the
 * dead-letter queue for a human to look at. Messages that aren't valid events go
 * straight to the dead-letter queue, since retrying can't fix them.
 */
export class EventConsumer {
  private constructor(
    private readonly options: ConsumerOptions,
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
    readonly topology: ConsumerTopology,
  ) {}

  static async start(options: ConsumerOptions): Promise<EventConsumer> {
    const connection = await connect(options.url);
    // See RabbitPublisher: handle 'error' so the following 'close' can stop the worker cleanly.
    connection.on('error', (err: Error) => logger.warn('broker connection error', { consumer: options.name, error: err.message }));
    const channel = await connection.createConfirmChannel();
    channel.on('error', (err: Error) => logger.warn('broker channel error', { consumer: options.name, error: err.message }));
    const topology = consumerTopology(options.prefix, options.name, options.retryDelaysMs);
    await assertConsumerTopology(channel, topology, options.bindings, options.retryDelaysMs, {
      queueExpiresMs: options.queueExpiresMs,
    });
    // Bounds how many unacknowledged messages this consumer holds at once.
    await channel.prefetch(options.prefetch ?? 10);
    const consumer = new EventConsumer(options, connection, channel, topology);
    await channel.consume(topology.queue, (msg) => {
      if (msg) void consumer.handle(msg);
    });
    return consumer;
  }

  private async handle(msg: ConsumeMessage): Promise<void> {
    const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 0);
    let event: DomainEvent;
    try {
      event = JSON.parse(msg.content.toString('utf8'));
      if (typeof event?.id !== 'string' || typeof event?.type !== 'string') throw new Error('not a domain event');
    } catch (err) {
      await this.forward(msg, this.topology.deadLetterQueue, attempt, `malformed message: ${(err as Error).message}`);
      logger.error('malformed message dead-lettered', { consumer: this.options.name });
      return;
    }

    const log = { consumer: this.options.name, event_id: event.id, event_type: event.type, correlation_id: event.correlation_id, attempt };
    try {
      const outcome = await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          'INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [this.options.name, event.id],
        );
        if (rowCount === 0) return 'duplicate';
        await this.options.handler(event, client);
        return 'processed';
      });
      this.channel.ack(msg);
      logger.info(outcome === 'processed' ? 'event processed' : 'duplicate event skipped', log);
    } catch (err) {
      const reason = (err as Error).message;
      const retryQueue = this.topology.retryQueues[attempt];
      if (retryQueue) {
        await this.forward(msg, retryQueue, attempt + 1, reason);
        logger.warn('event processing failed, will retry', { ...log, error: reason, retry_queue: retryQueue });
      } else {
        await this.forward(msg, this.topology.deadLetterQueue, attempt, reason);
        logger.error('event dead-lettered after retries', { ...log, error: reason });
      }
    }
  }

  /** Re-publishes a message elsewhere and only then acknowledges the original, so it can't be lost. */
  private async forward(msg: ConsumeMessage, queue: string, attempt: number, reason: string): Promise<void> {
    this.channel.sendToQueue(queue, msg.content, {
      ...msg.properties,
      persistent: true,
      headers: { ...msg.properties.headers, [ATTEMPT_HEADER]: attempt, [ERROR_HEADER]: reason.slice(0, 500) },
    });
    await this.channel.waitForConfirms();
    this.channel.ack(msg);
  }

  get name(): string {
    return this.options.name;
  }

  /** Resolves when the connection drops, so a worker can exit and be restarted. */
  closed(): Promise<void> {
    return new Promise((resolve) => this.connection.once('close', () => resolve()));
  }

  async stop(): Promise<void> {
    await this.connection.close().catch(() => {});
  }
}
