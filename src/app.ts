import express from 'express';
import { config } from './config';
import { redis } from './redis';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { requestLogger } from './middleware/requestLogger';
import { createRateLimiter, rateLimit } from './middleware/rateLimit';
import { currentUserId, requireAuth } from './middleware/requireAuth';
import { requireJson } from './middleware/requireJson';
import { accountsRouter } from './routes/accounts';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { transfersRouter } from './routes/transfers';

export function createApp() {
  const app = express();

  app.use(requestLogger);
  app.use(requireJson);
  app.use(express.json());

  const perUser = rateLimit(
    createRateLimiter({ redis, prefix: config.redisPrefix, limit: config.rateLimitPerWindow, windowMs: config.rateLimitWindowMs }),
    (_req, res) => `user:${currentUserId(res)}`,
  );
  // Stricter, per IP, where passwords are guessed.
  const perIpOnAuth = rateLimit(
    createRateLimiter({ redis, prefix: config.redisPrefix, limit: config.authRateLimitPerWindow, windowMs: config.rateLimitWindowMs }),
    (req) => `auth:${req.ip}`,
  );

  app.use(healthRouter);
  app.use(['/auth/login', '/auth/register'], perIpOnAuth);
  app.use('/auth', authRouter);
  app.use('/accounts', requireAuth, perUser, accountsRouter);
  app.use('/transfers', requireAuth, perUser, transfersRouter);
  app.use(notFound);

  app.use(errorHandler);

  return app;
}
