/** An amount as the API sent it, signed and coloured by direction. */
export function Amount({ value, direction }: { value: string; direction?: 'debit' | 'credit' }) {
  const sign = direction === 'debit' ? '−' : direction === 'credit' ? '+' : '';
  return <span className={`amount ${direction ?? ''}`}>{sign}{value}</span>;
}
