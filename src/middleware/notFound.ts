import type { RequestHandler } from 'express';
import { HttpError } from '../errors';

/** Mounted after a route's real handlers: the path exists, but not for this method. */
export function methodNotAllowed(allowed: string): RequestHandler {
  return (_req, res) => {
    res.set('Allow', allowed);
    throw new HttpError(405, 'method_not_allowed', `Method not allowed. Allowed: ${allowed}`);
  };
}

/** Mounted after all routers, so unknown paths get JSON instead of Express's HTML page. */
export const notFound: RequestHandler = (req) => {
  throw new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`);
};
