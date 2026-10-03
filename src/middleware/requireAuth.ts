import type { RequestHandler, Response } from 'express';
import { verifyAccessToken } from '../auth/tokens';
import { HttpError } from '../errors';

/** Requires `Authorization: Bearer <token>` and stores the user id in res.locals.userId. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const match = /^Bearer (\S+)$/.exec(req.get('Authorization') ?? '');
  if (!match) {
    res.set('WWW-Authenticate', 'Bearer');
    throw new HttpError(401, 'missing_token', 'Authorization: Bearer <token> header is required');
  }
  res.locals.userId = verifyAccessToken(match[1]!);
  next();
};

/** The authenticated user's id. Only valid on routes behind requireAuth. */
export function currentUserId(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== 'string') throw new Error('currentUserId used on a route without requireAuth');
  return userId;
}
