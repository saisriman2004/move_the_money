import type { RequestHandler } from 'express';
import { HttpError } from '../errors';

/**
 * Rejects request bodies that aren't JSON. Without this, express.json()
 * silently skips a form-encoded body and the request fails later with a
 * misleading "field is required".
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  // req.is() returns null when there is no body, false when the body isn't JSON.
  if (req.is('application/json') === false) {
    throw new HttpError(415, 'unsupported_media_type', 'Request body must be JSON (Content-Type: application/json)');
  }
  next();
};
