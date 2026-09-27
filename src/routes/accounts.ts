import { Router } from 'express';
import { HttpError } from '../errors';
import { parseAmount } from '../money';
import { createAccount, findAccount } from '../services/accounts';
import { parseAccountId, parseBody, parseName, requireField } from '../validation';

export const accountsRouter = Router();

accountsRouter.post('/', async (req, res) => {
  const body = parseBody(req.body, ['first_name', 'last_name', 'starting_balance']);
  const account = await createAccount({
    firstName: parseName(requireField(body, 'first_name'), 'first_name'),
    lastName: parseName(requireField(body, 'last_name'), 'last_name'),
    startingBalance: parseAmount(requireField(body, 'starting_balance'), 'starting_balance'),
  });
  res.status(201).json(account);
});

accountsRouter.get('/:id', async (req, res) => {
  const id = parseAccountId(req.params.id, 'Account id');
  const account = await findAccount(id);
  if (!account) {
    throw new HttpError(404, 'account_not_found', 'Account not found');
  }
  res.json(account);
});
