import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { logger } from '../logger';
import type { DomainEvent } from '../outbox';
import type { EventPublisher } from '../outbox-relay';
import { eventsExchange } from './topology';

/**
 * Publishes domain events to the topic exchange with the event type as routing key.
 * Uses a confirm channel: publish() resolves only once the broker has taken
 * responsibility for the message, so the outbox row is marked published only then.
 */
export class RabbitPublisher implements EventPublisher {
  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
    private readonly exchange: string,
    private readonly timeoutMs: number,
  ) {}

  static async connect(url: string, prefix: string, timeoutMs = 5000): Promise<RabbitPublisher> {
    const connection = await connect(url);
    // amqplib emits 'error' (e.g. a missed heartbeat) before 'close'. Unhandled, that
    // crashes the process; handled, the 'close' that follows lets the worker exit cleanly.
    connection.on('error', (err: Error) => logger.warn('broker connection error', { error: err.message }));
    const channel = await connection.createConfirmChannel();
    channel.on('error', (err: Error) => logger.warn('broker channel error', { error: err.message }));
    const exchange = eventsExchange(prefix);
    await channel.assertExchange(exchange, 'topic', { durable: true });
    return new RabbitPublisher(connection, channel, exchange, timeoutMs);
  }

  async publish(event: DomainEvent): Promise<void> {
    const body = Buffer.from(JSON.stringify(event));
    const confirmed = new Promise<void>((resolve, reject) => {
      this.channel.publish(
        this.exchange,
        event.type,
        body,
        {
          persistent: true,
          messageId: event.id,
          contentType: 'application/json',
          timestamp: Date.parse(event.occurred_at),
          headers: { 'x-correlation-id': event.correlation_id ?? undefined },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    // A broker that never answers must not hold the outbox batch open forever.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`broker did not confirm event ${event.id} within ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    try {
      await Promise.race([confirmed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves when the connection drops, so a worker can exit and be restarted. */
  closed(): Promise<void> {
    return new Promise((resolve) => this.connection.once('close', () => resolve()));
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => {});
  }
}
