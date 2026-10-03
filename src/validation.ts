import { HttpError } from './errors';

/**
 * Ensures a request body is a JSON object containing only the allowed fields.
 * A missing body is treated as {}. Unknown fields are rejected so a typo like
 * "startingbalance" fails loudly instead of being silently ignored.
 */
export function parseBody(body: unknown, allowedFields: readonly string[]): Record<string, unknown> {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'unknown_field', `Unknown field(s): ${unknown.join(', ')}`);
  }
  return body as Record<string, unknown>;
}

/** Throws a 400 if a required field is absent. An explicit null is left to the field's own validator. */
export function requireField(body: Record<string, unknown>, field: string): unknown {
  if (!(field in body)) {
    throw new HttpError(400, 'missing_field', `${field} is required`);
  }
  return body[field];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates an account id from a request. Checked here so a malformed id is a
 * 400, not a Postgres cast error (500).
 */
export function parseAccountId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new HttpError(400, 'invalid_account_id', `${field} must be a UUID`);
  }
  return value;
}

const MAX_NAME_LENGTH = 100;

/** Trims a name and checks it is 1-100 characters. Whitespace rules live here, not in the database. */
export function parseName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_name', `${field} must be a string`);
  }
  const name = value.trim();
  // Count code points, not UTF-16 units, so the limit matches Postgres length().
  const length = [...name].length;
  if (length === 0 || length > MAX_NAME_LENGTH) {
    throw new HttpError(400, 'invalid_name', `${field} must be 1 to ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lowercases an email address and checks its basic shape. */
export function parseEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, 'invalid_email', 'email must be a valid email address');
  }
  return email;
}

/** Passwords are kept exactly as typed (no trimming) and must be 8-128 characters. */
export function parsePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new HttpError(400, 'invalid_password', 'password must be 8 to 128 characters');
  }
  return value;
}

// Printable ASCII without spaces, so keys are safe to compare byte-for-byte.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * Reads the required Idempotency-Key header. Without a client-chosen key, a retry
 * and a second intentional request look identical, so every money movement needs one.
 */
export function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined) {
    throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new HttpError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 1-255 printable ASCII characters without spaces',
    );
  }
  return header;
}
