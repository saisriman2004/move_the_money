import { Router } from 'express';
import { config } from '../config';
import { HttpError } from '../errors';
import { methodNotAllowed } from '../middleware/notFound';
import { currentUserId } from '../middleware/requireAuth';
import { parseAccountId, parseBody, requireField } from '../validation';
import { createEndpoint, deactivateEndpoint, listDeliveries, listEndpoints, WEBHOOK_EVENTS } from '../webhooks/service';
import { parseWebhookUrl } from '../webhooks/urls';

export const webhooksRouter = Router();

function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((e) => typeof e === 'string' && (WEBHOOK_EVENTS as string[]).includes(e))) {
    throw new HttpError(400, 'invalid_events', `events must be a non-empty list of: ${WEBHOOK_EVENTS.join(', ')}`);
  }
  return [...new Set(value as string[])];
}

webhooksRouter.post('/', async (req, res) => {
  const body = parseBody(req.body, ['url', 'events']);
  const url = parseWebhookUrl(requireField(body, 'url'), config.webhooks.allowPrivateUrls);
  const events = parseEvents(requireField(body, 'events'));
  // The secret is only ever returned here; store it to verify signatures.
  res.status(201).json(await createEndpoint(currentUserId(res), url, events));
});

webhooksRouter.get('/', async (_req, res) => {
  res.json({ data: await listEndpoints(currentUserId(res)) });
});

webhooksRouter.delete('/:id', async (req, res) => {
  const id = parseAccountId(req.params.id, 'Webhook id');
  if (!(await deactivateEndpoint(currentUserId(res), id))) {
    throw new HttpError(404, 'webhook_not_found', 'Webhook not found');
  }
  res.status(204).end();
});

webhooksRouter.get('/:id/deliveries', async (req, res) => {
  const id = parseAccountId(req.params.id, 'Webhook id');
  const deliveries = await listDeliveries(currentUserId(res), id);
  if (!deliveries) throw new HttpError(404, 'webhook_not_found', 'Webhook not found');
  res.json({ data: deliveries });
});

webhooksRouter.all('/', methodNotAllowed('GET, HEAD, POST'));
webhooksRouter.all('/:id', methodNotAllowed('DELETE'));
webhooksRouter.all('/:id/deliveries', methodNotAllowed('GET, HEAD'));
