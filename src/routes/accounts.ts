import { Router } from 'express';
import { cacheAccount, getCachedAccount } from '../cache/accounts';
import { HttpError } from '../errors';
import { methodNotAllowed } from '../middleware/notFound';
import { parsePositiveAmount } from '../money';
import { currentUserId } from '../middleware/requireAuth';
import { createAccount, findOwnedAccount, listOwnedAccounts } from '../services/accounts';
import { listTransfersForAccount } from '../services/transfers';
import { parseAccountId, parseBody, parseName, requireField } from '../validation';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

export const accountsRouter = Router();

accountsRouter.post('/', async (req, res) => {
  const body = parseBody(req.body, ['first_name', 'last_name', 'starting_balance']);
  const account = await createAccount({
    userId: currentUserId(res),
    firstName: parseName(requireField(body, 'first_name'), 'first_name'),
    lastName: parseName(requireField(body, 'last_name'), 'last_name'),
    startingBalance: parsePositiveAmount(requireField(body, 'starting_balance'), 'starting_balance'),
    correlationId: res.locals.correlationId,
  });
  res.status(201).json(account);
});

accountsRouter.get('/', async (_req, res) => {
  res.json({ data: await listOwnedAccounts(currentUserId(res)) });
});

// Someone else's account returns 404, not 403, so ids can't be probed for existence.
accountsRouter.get('/:id', async (req, res) => {
  const id = parseAccountId(req.params.id, 'Account id');
  const userId = currentUserId(res);
  const cached = await getCachedAccount(id);
  if (cached) {
    // A cache hit still goes through the ownership check.
    if (cached.user_id !== userId) throw new HttpError(404, 'account_not_found', 'Account not found');
    const { user_id: _, ...account } = cached;
    res.set('X-Cache', 'HIT').json(account);
    return;
  }
  const account = await findOwnedAccount(id, userId);
  if (!account) {
    throw new HttpError(404, 'account_not_found', 'Account not found');
  }
  await cacheAccount({ ...account, user_id: userId });
  res.set('X-Cache', 'MISS').json(account);
});

accountsRouter.get('/:id/transactions', async (req, res) => {
  const id = parseAccountId(req.params.id, 'Account id');

  const rawLimit = req.query.limit;
  let limit = DEFAULT_HISTORY_LIMIT;
  if (rawLimit !== undefined) {
    limit = typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > MAX_HISTORY_LIMIT) {
      throw new HttpError(400, 'invalid_limit', `limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}`);
    }
  }

  if (!(await findOwnedAccount(id, currentUserId(res)))) {
    throw new HttpError(404, 'account_not_found', 'Account not found');
  }
  res.json({ data: await listTransfersForAccount(id, limit) });
});

accountsRouter.all('/', methodNotAllowed('GET, HEAD, POST'));
accountsRouter.all('/:id', methodNotAllowed('GET, HEAD'));
accountsRouter.all('/:id/transactions', methodNotAllowed('GET, HEAD'));
