import type { RequestHandler } from 'express';
import { HttpError } from '../errors';

/**
 * Rejects request bodies that declare a non-JSON type. Without this, express.json()
 * silently skips a form-encoded body and the request fails later with a misleading
 * "field is required".
 *
 * A body with no Content-Type at all is let through: proxies forward a body-less
 * POST with chunked encoding, so "has a body" can't be told from "empty" here. Such
 * a body isn't parsed, and required fields are still enforced by the route.
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  // req.is() returns null when there is no body, false when the body isn't JSON.
  if (req.get('Content-Type') !== undefined && req.is('application/json') === false) {
    throw new HttpError(415, 'unsupported_media_type', 'Request body must be JSON (Content-Type: application/json)');
  }
  next();
};
