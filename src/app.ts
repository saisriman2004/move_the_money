import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { requireJson } from './middleware/requireJson';
import { accountsRouter } from './routes/accounts';
import { transfersRouter } from './routes/transfers';

export function createApp() {
  const app = express();

  app.use(requireJson);
  app.use(express.json());

  app.use('/accounts', accountsRouter);
  app.use('/transfers', transfersRouter);
  app.use(notFound);

  app.use(errorHandler);

  return app;
}
