import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../logger';

// Accept a caller's request id only if it is short and safe to put in a log line.
const REQUEST_ID_PATTERN = /^[\w.-]{1,100}$/;

/**
 * Gives every request an id (returned in the X-Request-Id header) and logs one
 * line when the response finishes. Search the log for the id to find the
 * request and any error it caused.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.get('X-Request-Id');
  const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = requestId;
  res.set('X-Request-Id', requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const fields = {
      request_id: requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
      // Set by the error handler, so a 4xx line says which rule the request broke.
      error_code: res.locals.errorCode,
    };
    if (res.statusCode >= 500) logger.error('request failed', fields);
    else if (res.statusCode >= 400) logger.warn('request rejected', fields);
    else logger.info('request completed', fields);
  });
  next();
};
