import { config } from '../config';
import { closePool } from '../db';
import { logger, setService } from '../logger';
import { scrapeGauge, startMetricsServer } from '../metrics';
import { EventConsumer } from '../messaging/consumer';
import { notifyFromEvent } from '../notifications/service';

setService('notifications');

async function main() {
  const metrics = startMetricsServer(config.workerMetricsPort(9102), 'notifications');
  const consumer = await EventConsumer.start({
    name: 'notifications',
    bindings: ['account.created', 'transfer.completed', 'transfer.refunded'],
    handler: async (event, client) => {
      await notifyFromEvent(event, client);
    },
    url: config.rabbitmqUrl,
    prefix: config.amqpPrefix,
    retryDelaysMs: config.consumerRetryDelaysMs,
  });
  scrapeGauge('rabbitmq_queue_messages', 'Messages waiting in a queue', ['queue'], async (g) => {
    for (const { queue, messages } of await consumer.queueDepths()) g.set({ queue }, messages);
  });
  logger.info('notification worker started');

  let stopping = false;
  const stop = async () => {
    stopping = true;
    await consumer.stop();
    await closePool();
    metrics.close();
    logger.info('notification worker stopped');
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop());
  await consumer.closed();
  if (!stopping) {
    logger.error('broker connection closed unexpectedly');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('notification worker crashed', { error: (err as Error).message });
  process.exit(1);
});
