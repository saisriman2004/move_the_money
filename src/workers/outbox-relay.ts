import { config } from '../config';
import { closePool } from '../db';
import { logger } from '../logger';
import { RabbitPublisher } from '../messaging/publisher';
import { runRelay } from '../outbox-relay';

async function main() {
  const publisher = await RabbitPublisher.connect(config.rabbitmqUrl, config.amqpPrefix);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => controller.abort());
  }
  // If the broker connection drops, stop and let the process manager restart us.
  void publisher.closed().then(() => {
    if (controller.signal.aborted) return; // we closed it ourselves while shutting down
    logger.error('broker connection closed unexpectedly');
    process.exitCode = 1;
    controller.abort();
  });

  logger.info('outbox relay started');
  await runRelay(publisher, {
    signal: controller.signal,
    onError: (err) => logger.error('outbox relay batch failed', { error: (err as Error).message }),
  });
  await publisher.close();
  await closePool();
  logger.info('outbox relay stopped');
}

main().catch((err) => {
  logger.error('outbox relay crashed', { error: (err as Error).message });
  process.exit(1);
});
