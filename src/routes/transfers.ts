import { Router } from 'express';
import { HttpError } from '../errors';
import { parsePositiveAmount } from '../money';
import { createTransfer } from '../services/transfers';
import { parseAccountId, parseBody, requireField } from '../validation';

// Printable ASCII without spaces, so keys are safe to log and compare byte-for-byte.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

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

  const idempotencyKey = req.get('Idempotency-Key');
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new HttpError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 1-255 printable ASCII characters without spaces',
    );
  }

  const { transfer, replayed } = await createTransfer({ fromAccountId, toAccountId, amount, idempotencyKey });
  if (replayed) res.set('Idempotent-Replayed', 'true');
  res.status(201).json(transfer);
});
