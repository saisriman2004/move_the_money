import { config } from './config';
import { createApp } from './app';
import { logger } from './logger';

// Fail fast on a missing or weak secret instead of on the first login.
void config.jwtSecret;

const app = createApp();

app.listen(config.port, () => {
  logger.info('server started', { port: config.port, env: config.nodeEnv, log_file: config.logFile });
});
