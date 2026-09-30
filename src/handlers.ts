import type { ErrorRequestHandler, RequestHandler } from 'express';
import { codeForStatus, defaultMessage } from './error-codes';
import { buildErrorResponse, httpErrorBody, HttpError } from './errors';

/** Catch-all for unknown routes; mount after every router. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(buildErrorResponse('NOT_FOUND', 'Route not found'));
};

export interface ErrorHandlerOptions {
  /** Called for every 5xx with the original error. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

/**
 * Final error handler; mount last. It keeps the status of the error instead of flattening to 400:
 * - `HttpError` -> its own status, code, message and details
 * - body-parser / Express errors carrying a 4xx `status` -> that status with a generic message
 * - anything else -> 500, without leaking the message
 */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  const report = options.onError ?? ((error: unknown) => console.error(error));
  return (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      if (error.status >= 500) report(error);
      return res.status(error.status).json(httpErrorBody(error));
    }
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = codeForStatus(status);
      return res.status(status).json(buildErrorResponse(code, defaultMessage(code)));
    }
    report(error);
    return res.status(500).json(buildErrorResponse('INTERNAL_ERROR', defaultMessage('INTERNAL_ERROR')));
  };
}
