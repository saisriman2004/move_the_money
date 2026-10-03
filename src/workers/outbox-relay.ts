import { closePool } from '../db';
import { logger } from '../logger';
import { runRelay, type EventPublisher } from '../outbox-relay';

// Until a message broker is configured, events are only logged.
const publisher: EventPublisher = {
  async publish(event) {
    logger.info('event published', { event_id: event.id, event_type: event.type, correlation_id: event.correlation_id });
  },
};

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

logger.info('outbox relay started');
runRelay(publisher, { signal: controller.signal, onError: (err) => logger.error('outbox relay batch failed', { error: (err as Error).message }) })
  .finally(async () => {
    await closePool();
    logger.info('outbox relay stopped');
  });
