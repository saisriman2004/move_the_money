/** An error that the error middleware turns into `{ error: code, message }` with this status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
