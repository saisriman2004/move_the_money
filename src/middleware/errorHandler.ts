import type { ErrorRequestHandler } from 'express';
import { HttpError } from '../errors';

// Express 5 forwards errors thrown in async route handlers to this middleware.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  // express.json() rejected the body: the client's fault, not ours.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'malformed_json', message: 'Request body is not valid JSON' });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
};
