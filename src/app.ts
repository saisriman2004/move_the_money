import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { requestLogger } from './middleware/requestLogger';
import { requireAuth } from './middleware/requireAuth';
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

  app.use(healthRouter);
  app.use('/auth', authRouter);
  app.use('/accounts', requireAuth, accountsRouter);
  app.use('/transfers', requireAuth, transfersRouter);
  app.use(notFound);

  app.use(errorHandler);

  return app;
}
