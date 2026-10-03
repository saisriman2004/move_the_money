import { config } from '../config';
import { closePool } from '../db';
import { logger, setService } from '../logger';
import { scrapeGauge, startMetricsServer } from '../metrics';
import { EventConsumer } from '../messaging/consumer';
import { fanOutEvent, runDispatcher } from '../webhooks/service';

/**
 * Two loops in one process: a RabbitMQ consumer that turns events into pending
 * deliveries, and a dispatcher that sends due deliveries over HTTP with retries.
 * Slow customer endpoints only slow the dispatcher, never the queue.
 */
setService('webhooks');

async function main() {
  const metrics = startMetricsServer(config.workerMetricsPort(9103), 'webhooks');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());

  const consumer = await EventConsumer.start({
    name: 'webhooks',
    bindings: ['account.created', 'transfer.completed', 'transfer.refunded'],
    handler: async (event, client) => {
      await fanOutEvent(event, client);
    },
    url: config.rabbitmqUrl,
    prefix: config.amqpPrefix,
    retryDelaysMs: config.consumerRetryDelaysMs,
  });
  void consumer.closed().then(() => {
    if (controller.signal.aborted) return;
    logger.error('broker connection closed unexpectedly');
    process.exitCode = 1;
    controller.abort();
  });

  scrapeGauge('rabbitmq_queue_messages', 'Messages waiting in a queue', ['queue'], async (g) => {
    for (const { queue, messages } of await consumer.queueDepths()) g.set({ queue }, messages);
  });
  logger.info('webhook worker started');
  await runDispatcher({
    signal: controller.signal,
    onError: (err) => logger.error('webhook dispatch failed', { error: (err as Error).message }),
  });
  await consumer.stop();
  await closePool();
  metrics.close();
  logger.info('webhook worker stopped');
}

main().catch((err) => {
  logger.error('webhook worker crashed', { error: (err as Error).message });
  process.exit(1);
});
