import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { describeError } from './describe-error';
import { codeForStatus, defaultMessage } from './error-codes';
import { buildErrorResponse, httpErrorBody, HttpError } from './errors';
import { logger as defaultLogger, requestId, type Logger } from './logger';

/** Catch-all for unknown routes; mount after every router. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(buildErrorResponse('NOT_FOUND', 'Route not found'));
};

export interface ErrorHandlerOptions {
  /**
   * Called for every 5xx with the original error, instead of the default log line. Never log the error
   * itself: its upstream `cause` holds the caller's token and the request and response bodies (MAIR-290);
   * log `describeError(error)`.
   */
  onError?: (error: unknown) => void;
  /**
   * Logger of the default report (MAIR-531): one `error` line `request failed` with `request_id`, `status`
   * and `error` = `describeError(error)`. Default: the lib's `logger`.
   */
  logger?: Logger;
}

/**
 * Final error handler; mount last. It keeps the status of the error instead of flattening to 400:
 * - `HttpError` -> its own status, code, message and details (and `Retry-After` when it carries `retryAfterSeconds`)
 * - body-parser / Express errors carrying a 4xx `status` -> that status with a generic message
 * - anything else -> 500, without leaking the message
 */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  const log = options.logger ?? defaultLogger;
  const report = (error: unknown, req: Request, status: number) => {
    if (options.onError) return options.onError(error);
    log.error('request failed', { request_id: requestId(req), status, error: describeError(error) });
  };
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      if (error.status >= 500) report(error, req, error.status);
      if (error.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(error.status).json(httpErrorBody(error));
    }
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = codeForStatus(status);
      return res.status(status).json(buildErrorResponse(code, defaultMessage(code)));
    }
    report(error, req, 500);
    return res.status(500).json(buildErrorResponse('INTERNAL_ERROR', defaultMessage('INTERNAL_ERROR')));
  };
}
