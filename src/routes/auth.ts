import { Router } from 'express';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/passwords';
import { signAccessToken } from '../auth/tokens';
import { HttpError } from '../errors';
import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { methodNotAllowed } from '../middleware/notFound';
import { createUser, findUser, findUserForLogin } from '../services/users';
import { parseBody, parseEmail, parsePassword, requireField } from '../validation';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const body = parseBody(req.body, ['email', 'password']);
  const email = parseEmail(requireField(body, 'email'));
  const password = parsePassword(requireField(body, 'password'));
  const user = await createUser(email, await hashPassword(password));
  res.status(201).json({ user, token: signAccessToken(user.id) });
});

authRouter.post('/login', async (req, res) => {
  const body = parseBody(req.body, ['email', 'password']);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = await findUserForLogin(email);
  // Hash even for unknown emails, so response time doesn't reveal which emails are registered.
  const valid = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
  if (!user || !valid) {
    throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
  }
  const { password_hash: _, ...publicUser } = user;
  res.json({ user: publicUser, token: signAccessToken(user.id) });
});

authRouter.get('/me', requireAuth, async (_req, res) => {
  const user = await findUser(currentUserId(res));
  if (!user) {
    // The token is valid but the user no longer exists.
    throw new HttpError(401, 'invalid_token', 'Access token is invalid');
  }
  res.json(user);
});

authRouter.all('/register', methodNotAllowed('POST'));
authRouter.all('/login', methodNotAllowed('POST'));
authRouter.all('/me', methodNotAllowed('GET, HEAD'));
