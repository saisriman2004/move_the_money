// Mirrors the API's rule: a decimal string with up to 18 integer digits and 2 decimals.
// Amounts stay strings end to end; the browser never does arithmetic on money.
const AMOUNT = /^\d{1,18}(\.\d{1,2})?$/;

export function validateAmount(input: string): string | null {
  const value = input.trim();
  if (!AMOUNT.test(value)) return 'Enter an amount like 25 or 25.50';
  if (/^0+(\.0+)?$/.test(value)) return 'Amount must be greater than zero';
  return null;
}

/** "…1a2b": the last four characters, enough to recognise an id. */
export const shortId = (id: string) => `…${id.slice(-4)}`;
