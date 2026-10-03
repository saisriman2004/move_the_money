import { config } from '../config';
import { closePool } from '../db';
import { logger } from '../logger';
import { EventConsumer } from '../messaging/consumer';
import { notifyFromEvent } from '../notifications/service';

async function main() {
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
  logger.info('notification worker started');

  let stopping = false;
  const stop = async () => {
    stopping = true;
    await consumer.stop();
    await closePool();
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
