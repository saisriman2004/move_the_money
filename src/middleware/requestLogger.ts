import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../logger';
import { httpDuration, httpRequests } from '../metrics';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The path with ids replaced, so metric labels stay few ("/api/v1/accounts/:id"). */
function routeLabel(path: string, unmatched: boolean): string {
  if (unmatched) return 'unmatched';
  return path.split('?')[0]!.replace(UUID, ':id');
}

// Accept a caller's request id only if it is short and safe to put in a log line.
const REQUEST_ID_PATTERN = /^[\w.-]{1,100}$/;

/**
 * Gives every request an id (X-Request-Id) and a correlation id (X-Correlation-Id),
 * and logs one line when the response finishes.
 *
 * The request id names this one HTTP request. The correlation id names the whole
 * piece of work: a caller can pass its own to tie several requests together, and it
 * travels on into outbox events, consumers and webhook logs. Without one, it equals
 * the request id.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.get('X-Request-Id');
  const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = requestId;
  res.set('X-Request-Id', requestId);
  const incomingCorrelation = req.get('X-Correlation-Id');
  const correlationId = incomingCorrelation && REQUEST_ID_PATTERN.test(incomingCorrelation) ? incomingCorrelation : requestId;
  res.locals.correlationId = correlationId;
  res.set('X-Correlation-Id', correlationId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const fields = {
      request_id: requestId,
      correlation_id: correlationId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
      // Set by the error handler, so a 4xx line says which rule the request broke.
      error_code: res.locals.errorCode,
    };
    const route = routeLabel(req.originalUrl, res.locals.errorCode === 'not_found');
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    httpDuration.observe({ method: req.method, route }, fields.duration_ms / 1000);
    if (res.statusCode >= 500) logger.error('request failed', fields);
    else if (res.statusCode >= 400) logger.warn('request rejected', fields);
    else logger.info('request completed', fields);
  });
  next();
};
