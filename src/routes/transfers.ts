import { Router } from 'express';
import { HttpError } from '../errors';
import { parsePositiveAmount } from '../money';
import { createTransfer } from '../services/transfers';
import { parseAccountId, parseBody, requireField } from '../validation';

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

  const transfer = await createTransfer({ fromAccountId, toAccountId, amount });
  res.status(201).json(transfer);
});
