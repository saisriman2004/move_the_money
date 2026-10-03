/** An error that the error middleware turns into `{ error: code, message }` with this status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Extra fields added to the error body, e.g. { reasons: [...] }. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
