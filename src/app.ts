import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { accountsRouter } from './routes/accounts';

export function createApp() {
  const app = express();

  app.use(express.json());

  app.use('/accounts', accountsRouter);

  app.use(errorHandler);

  return app;
}
