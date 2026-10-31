import { codeForStatus, defaultMessage, type ErrorCode } from './error-codes';
import type { ErrorDetail, ErrorResponse } from './schema';

export interface HttpErrorOptions {
  code?: ErrorCode;
  details?: ErrorDetail[];
  /** The original error (e.g. a failed upstream call): logged by `errorHandler` for 5xx, never sent to the client. */
  cause?: unknown;
  /** Seconds the client should wait before retrying: sent as `Retry-After` by `errorHandler` (MAIR-562). */
  retryAfterSeconds?: number;
}

/** An error a route can throw to answer with a precise status; its message is sent to the client as is. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[];
  readonly cause?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(status: number, message?: string, options: HttpErrorOptions = {}) {
    const code = options.code ?? codeForStatus(status);
    super(message ?? defaultMessage(code));
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = options.details ?? [];
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function buildErrorResponse(code: ErrorCode, message: string, details: ErrorDetail[] = []): ErrorResponse {
  return { error: { code, message, details } };
}

export function httpErrorBody(error: HttpError): ErrorResponse {
  return buildErrorResponse(error.code, error.message, error.details);
}
