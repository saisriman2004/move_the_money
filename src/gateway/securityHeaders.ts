import type { RequestHandler } from 'express';

/** Conservative defaults for a JSON API that is never meant to be framed or sniffed. */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Cache-Control': 'no-store',
  });
  next();
};
