import { Router } from 'express';
import { HttpError } from '../errors';
import { methodNotAllowed } from '../middleware/notFound';
import { currentUserId } from '../middleware/requireAuth';
import { parsePositiveAmount } from '../money';
import { createTransfer, findTransferForUser, refundTransfer } from '../services/transfers';
import { parseAccountId, parseBody, parseIdempotencyKey, requireField } from '../validation';

export const transfersRouter = Router();

transfersRouter.post('/', async (req, res) => {
  const body = parseBody(req.body, ['from_account_id', 'to_account_id', 'amount']);
  const fromAccountId = parseAccountId(requireField(body, 'from_account_id'), 'from_account_id');
  const toAccountId = parseAccountId(requireField(body, 'to_account_id'), 'to_account_id');
  // UUIDs are case-insensitive, so compare lowercased; Postgres would otherwise reject it with a 500.
  if (fromAccountId.toLowerCase() === toAccountId.toLowerCase()) {
    throw new HttpError(400, 'same_account', 'from_account_id and to_account_id must differ');
  }
  const amount = parsePositiveAmount(requireField(body, 'amount'), 'amount');
  const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));

  const { transfer, replayed } = await createTransfer({
    userId: currentUserId(res),
    fromAccountId,
    toAccountId,
    amount,
    idempotencyKey,
    correlationId: res.locals.correlationId,
  });
  if (replayed) res.set('Idempotent-Replayed', 'true');
  res.status(201).json(transfer);
});

transfersRouter.get('/:id', async (req, res) => {
  const id = parseAccountId(req.params.id, 'Transfer id');
  const transfer = await findTransferForUser(id, currentUserId(res));
  if (!transfer) {
    throw new HttpError(404, 'transfer_not_found', 'Transfer not found');
  }
  res.json(transfer);
});

transfersRouter.post('/:id/refund', async (req, res) => {
  const transferId = parseAccountId(req.params.id, 'Transfer id');
  parseBody(req.body, []);
  const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));
  const { transfer, replayed } = await refundTransfer({
    userId: currentUserId(res),
    transferId,
    idempotencyKey,
    correlationId: res.locals.correlationId,
  });
  if (replayed) res.set('Idempotent-Replayed', 'true');
  res.status(201).json(transfer);
});

transfersRouter.all('/', methodNotAllowed('POST'));
transfersRouter.all('/:id', methodNotAllowed('GET, HEAD'));
transfersRouter.all('/:id/refund', methodNotAllowed('POST'));
