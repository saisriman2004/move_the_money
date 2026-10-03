import { Router } from 'express';
import { HttpError } from '../errors';
import { methodNotAllowed } from '../middleware/notFound';
import { currentUserId } from '../middleware/requireAuth';
import { listNotifications, markAllRead, markRead } from '../notifications/service';
import { parseAccountId, parseBody } from '../validation';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const { unread, limit: rawLimit } = req.query;
  if (unread !== undefined && unread !== 'true' && unread !== 'false') {
    throw new HttpError(400, 'invalid_query', 'unread must be true or false');
  }
  let limit = 50;
  if (rawLimit !== undefined) {
    limit = typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > 100) throw new HttpError(400, 'invalid_limit', 'limit must be an integer from 1 to 100');
  }
  res.json(await listNotifications(currentUserId(res), { unreadOnly: unread === 'true', limit }));
});

notificationsRouter.post('/read-all', async (req, res) => {
  parseBody(req.body, []);
  await markAllRead(currentUserId(res));
  res.status(204).end();
});

notificationsRouter.post('/:id/read', async (req, res) => {
  parseBody(req.body, []);
  const id = parseAccountId(req.params.id, 'Notification id');
  if (!(await markRead(currentUserId(res), id))) {
    throw new HttpError(404, 'notification_not_found', 'Notification not found');
  }
  res.status(204).end();
});

notificationsRouter.all('/', methodNotAllowed('GET, HEAD'));
notificationsRouter.all('/read-all', methodNotAllowed('POST'));
notificationsRouter.all('/:id/read', methodNotAllowed('POST'));
