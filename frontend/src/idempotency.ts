/**
 * One key per intended payment. The key is created on the first attempt and kept
 * until the server gives a definite answer, so retrying after a network error or
 * a 5xx sends the same key and can't pay twice. Editing the form starts a new payment.
 */
export class PaymentAttempt {
  private key: string | null = null;

  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

  /** The key to send with this submission. */
  keyForSubmit(): string {
    this.key ??= this.newKey();
    return this.key;
  }

  /** Call with the outcome: a definite answer (2xx or 4xx) finishes the payment. */
  settle(outcome: 'definite' | 'uncertain'): void {
    if (outcome === 'definite') this.key = null;
  }

  /** The user changed what they're paying, so it's a different request. */
  reset(): void {
    this.key = null;
  }

  get pending(): boolean {
    return this.key !== null;
  }
}
