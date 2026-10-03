import type { RequestHandler } from 'express';

const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Correlation-Id';
// Response headers a browser app may read.
const EXPOSED_HEADERS = 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, Idempotent-Replayed, X-Request-Id, X-Correlation-Id, X-Cache';

/**
 * CORS for an explicit allowlist of origins. A listed origin gets the CORS headers
 * on every response, errors included (otherwise a browser can't read a 401 or 429).
 * Preflight requests are answered here, before authentication. Unlisted origins get
 * no CORS headers, so browsers refuse to share responses with them.
 */
export function cors(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('Origin');
    res.vary('Origin');
    if (origin && allowed.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    }
    if (req.method === 'OPTIONS' && req.get('Access-Control-Request-Method')) {
      if (origin && allowed.has(origin)) {
        res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        res.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.set('Access-Control-Max-Age', '600');
      }
      res.status(204).end();
      return;
    }
    next();
  };
}
