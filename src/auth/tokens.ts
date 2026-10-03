import jwt from 'jsonwebtoken';
import { config } from '../config';
import { HttpError } from '../errors';

const ISSUER = 'move-the-money';

/** Signs a short-lived access token whose subject is the user id. */
export function signAccessToken(userId: string): string {
  return jwt.sign({}, config.jwtSecret, {
    algorithm: 'HS256',
    subject: userId,
    issuer: ISSUER,
    expiresIn: config.jwtTtlSeconds,
  });
}

/** Returns the user id from a valid token, or throws a 401. */
export function verifyAccessToken(token: string): string {
  try {
    // Pinning the algorithm rejects "alg: none" and algorithm-confusion tokens.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('no subject');
    return payload.sub;
  } catch (err) {
    const message = err instanceof jwt.TokenExpiredError ? 'Access token has expired' : 'Access token is invalid';
    throw new HttpError(401, 'invalid_token', message);
  }
}
