// Typed HTTP errors + a single Express error handler that renders them as JSON.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg = 'bad_request', details?: unknown): HttpError =>
  new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'unauthorized'): HttpError => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'forbidden', details?: unknown): HttpError =>
  new HttpError(403, 'forbidden', msg, details);
export const notFound = (msg = 'not_found'): HttpError => new HttpError(404, 'not_found', msg);
export const conflict = (msg = 'conflict', details?: unknown): HttpError =>
  new HttpError(409, 'conflict', msg, details);
export const tooMany = (msg = 'rate_limited'): HttpError => new HttpError(429, 'rate_limited', msg);
