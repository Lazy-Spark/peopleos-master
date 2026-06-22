/**
 * Application-level error carrying an HTTP status and an ApiError envelope code.
 * Thrown from route handlers/services; the global error handler in app.ts maps it
 * to the uniform `{ error: { code, message, details? } }` response.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message: string, details?: unknown): HttpError =>
  new HttpError(404, "NOT_FOUND", message, details);

export const conflict = (message: string, details?: unknown): HttpError =>
  new HttpError(409, "CONFLICT", message, details);

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, "BAD_REQUEST", message, details);

export const forbidden = (message: string, details?: unknown): HttpError =>
  new HttpError(403, "FORBIDDEN", message, details);
