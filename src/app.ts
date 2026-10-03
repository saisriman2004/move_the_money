import express from 'express';
import { config } from './config';
import { redis } from './redis';
import { cors } from './gateway/cors';
import { securityHeaders } from './gateway/securityHeaders';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { requestLogger } from './middleware/requestLogger';
import { createRateLimiter, rateLimit } from './middleware/rateLimit';
import { currentUserId, requireAuth } from './middleware/requireAuth';
import { requireJson } from './middleware/requireJson';
import { accountsRouter } from './routes/accounts';
import { authRouter } from './routes/auth';
import { notificationsRouter } from './routes/notifications';
import { healthRouter } from './routes/health';
import { transfersRouter } from './routes/transfers';
import { webhooksRouter } from './routes/webhooks';

/**
 * The API. The first middleware is the gateway layer every request passes through:
 * request and correlation ids, security headers, CORS, then content checks. All
 * routes live under /api/v1, so a future /api/v2 can run alongside; health checks
 * stay at the root for load balancers.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(cors(config.corsOrigins));
  app.use(requireJson);
  app.use(express.json({ limit: '100kb' }));

  const perUser = rateLimit(
    createRateLimiter({ redis, prefix: config.redisPrefix, limit: config.rateLimitPerWindow, windowMs: config.rateLimitWindowMs }),
    (_req, res) => `user:${currentUserId(res)}`,
  );
  // Stricter, per IP, where passwords are guessed.
  const perIpOnAuth = rateLimit(
    createRateLimiter({ redis, prefix: config.redisPrefix, limit: config.authRateLimitPerWindow, windowMs: config.rateLimitWindowMs }),
    (req) => `auth:${req.ip}`,
  );

  const v1 = express.Router();
  v1.use(['/auth/login', '/auth/register'], perIpOnAuth);
  v1.use('/auth', authRouter);
  v1.use('/accounts', requireAuth, perUser, accountsRouter);
  v1.use('/transfers', requireAuth, perUser, transfersRouter);
  v1.use('/webhooks', requireAuth, perUser, webhooksRouter);
  v1.use('/notifications', requireAuth, perUser, notificationsRouter);

  app.use(healthRouter);
  app.use('/api/v1', v1);
  app.use(notFound);

  app.use(errorHandler);

  return app;
}
