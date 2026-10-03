import { config } from '../config';
import { closePool } from '../db';
import { logger } from '../logger';
import { reconcile } from '../reconciliation';

/** Runs reconciliation now and then every RECONCILIATION_INTERVAL_MS until stopped. */
async function main() {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
  logger.info('reconciliation worker started', { interval_ms: config.reconciliationIntervalMs });
  while (!controller.signal.aborted) {
    try {
      await reconcile();
    } catch (err) {
      logger.error('reconciliation run failed', { error: (err as Error).message });
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, config.reconciliationIntervalMs);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(undefined);
      }, { once: true });
    });
  }
  await closePool();
  logger.info('reconciliation worker stopped');
}

main().catch((err) => {
  logger.error('reconciliation worker crashed', { error: (err as Error).message });
  process.exit(1);
});
