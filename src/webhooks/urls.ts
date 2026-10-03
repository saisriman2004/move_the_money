import { isIP } from 'node:net';
import { HttpError } from '../errors';

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./];

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (isIP(host) === 4) return PRIVATE_V4.some((re) => re.test(host));
  if (isIP(host) === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return false;
}

/**
 * Accepts http(s) URLs only. Unless private URLs are allowed, rejects hosts that
 * point inside the network (localhost, private and link-local ranges), so a
 * customer can't make the server call internal services. Names that resolve to
 * private addresses (DNS rebinding) are not caught here.
 */
export function parseWebhookUrl(value: unknown, allowPrivate: boolean): string {
  let url: URL;
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('bad');
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'invalid_url', 'url must be an absolute http or https URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, 'invalid_url', 'url must be an absolute http or https URL');
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw new HttpError(400, 'invalid_url', 'url must not point to a private or local address');
  }
  return url.toString();
}
