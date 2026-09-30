import { codeForStatus, defaultMessage, type ErrorCode } from './error-codes';
import type { ErrorDetail, ErrorResponse } from './schema';

/** An error a route can throw to answer with a precise status; its message is sent to the client as is. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[];

  constructor(status: number, message?: string, options: { code?: ErrorCode; details?: ErrorDetail[] } = {}) {
    const code = options.code ?? codeForStatus(status);
    super(message ?? defaultMessage(code));
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = options.details ?? [];
  }
}

export function buildErrorResponse(code: ErrorCode, message: string, details: ErrorDetail[] = []): ErrorResponse {
  return { error: { code, message, details } };
}

export function httpErrorBody(error: HttpError): ErrorResponse {
  return buildErrorResponse(error.code, error.message, error.details);
}
