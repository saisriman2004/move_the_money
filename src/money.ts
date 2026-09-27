import { HttpError } from './errors';

// Up to 18 digits before the point and 2 after, matching NUMERIC(20,2).
const AMOUNT_PATTERN = /^\d{1,18}(\.\d{1,2})?$/;

/**
 * Validates a money value from a request body and returns it as a decimal
 * string for Postgres. Only strings like "100.50" are accepted: a JSON number
 * may already have been rounded by floating point before we see it. Rejects
 * negatives, more than two decimal places, exponents, and anything
 * non-numeric, instead of letting Postgres silently round it.
 */
export function parseAmount(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_amount', `${field} must be a string, e.g. "100.00"`);
  }
  if (!AMOUNT_PATTERN.test(value)) {
    throw new HttpError(
      400,
      'invalid_amount',
      `${field} must be a non-negative amount with at most 2 decimal places`,
    );
  }
  return value;
}

/** Like parseAmount, but also rejects zero. */
export function parsePositiveAmount(value: unknown, field: string): string {
  const amount = parseAmount(value, field);
  if (/^0+(\.0+)?$/.test(amount)) {
    throw new HttpError(400, 'invalid_amount', `${field} must be greater than zero`);
  }
  return amount;
}
