import type { Channel } from 'amqplib';
import type { EventType } from '../outbox';

/** Names of everything a consumer needs on the broker. */
export interface ConsumerTopology {
  exchange: string;
  queue: string;
  /** One delay queue per retry attempt; each dead-letters back into `queue` when its TTL expires. */
  retryQueues: string[];
  deadLetterQueue: string;
}

export function eventsExchange(prefix: string): string {
  return `${prefix}events`;
}

export function consumerTopology(prefix: string, consumer: string, retryDelaysMs: number[]): ConsumerTopology {
  const queue = `${prefix}${consumer}`;
  return {
    exchange: eventsExchange(prefix),
    queue,
    retryQueues: retryDelaysMs.map((ms) => `${queue}.retry.${ms}ms`),
    deadLetterQueue: `${queue}.dead`,
  };
}

/**
 * Declares (idempotently) the events exchange, the consumer's queue bound to the
 * event types it wants, its delay queues and its dead-letter queue.
 *
 *   events (topic) --[routing key = event type]--> queue --> consumer
 *                                                    ^          | fails
 *                    retry.<delay> (TTL, then back) -+----------+
 *                                                               | out of retries
 *                                                    dead <-----+
 */
export async function assertConsumerTopology(
  channel: Channel,
  topology: ConsumerTopology,
  bindings: (EventType | string)[],
  retryDelaysMs: number[],
  options: { queueExpiresMs?: number } = {},
): Promise<void> {
  // Test runs set queueExpiresMs so their throwaway queues are removed once unused.
  const expiry = options.queueExpiresMs ? { 'x-expires': options.queueExpiresMs } : {};
  await channel.assertExchange(topology.exchange, 'topic', { durable: true });
  await channel.assertQueue(topology.queue, { durable: true, arguments: { ...expiry } });
  for (const key of bindings) {
    await channel.bindQueue(topology.queue, topology.exchange, key);
  }
  for (const [i, ms] of retryDelaysMs.entries()) {
    await channel.assertQueue(topology.retryQueues[i]!, {
      durable: true,
      arguments: {
        ...expiry,
        'x-message-ttl': ms,
        // When the delay expires, the message goes straight back to the consumer's queue.
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': topology.queue,
      },
    });
  }
  await channel.assertQueue(topology.deadLetterQueue, { durable: true, arguments: { ...expiry } });
}
