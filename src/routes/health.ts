import { Router } from 'express';
import { pool } from '../db';
import { HttpError } from '../errors';
import { methodNotAllowed } from '../middleware/notFound';

export const healthRouter = Router();

/** Liveness: the process is up and serving requests. Never touches the database. */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness: the app can do real work, which needs the database. */
healthRouter.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
  } catch {
    throw new HttpError(503, 'not_ready', 'Database is unreachable');
  }
  res.json({ status: 'ready' });
});

healthRouter.all('/health', methodNotAllowed('GET, HEAD'));
healthRouter.all('/ready', methodNotAllowed('GET, HEAD'));
