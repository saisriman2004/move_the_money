import type { ErrorRequestHandler } from 'express';
import { HttpError } from '../errors';
import { errorFields, logger } from '../logger';

// Express 5 forwards errors thrown in async route handlers to this middleware.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.locals.errorCode = err.code;
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  // express.json() rejected the body: the client's fault, not ours.
  if (err?.type === 'entity.parse.failed') {
    res.locals.errorCode = 'malformed_json';
    res.status(400).json({ error: 'malformed_json', message: 'Request body is not valid JSON' });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.locals.errorCode = 'payload_too_large';
    res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large' });
    return;
  }
  // Unexpected: log everything needed to debug it, but tell the client nothing internal.
  res.locals.errorCode = 'internal_error';
  logger.error('unhandled error', {
    request_id: res.locals.requestId,
    method: req.method,
    path: req.originalUrl,
    body: req.body,
    ...errorFields(err),
  });
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
};
