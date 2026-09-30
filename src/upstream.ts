import { HttpError } from './errors';

/**
 * Turns a failed upstream call (generated client, axios, fetch wrapper) into the error the BFF answers with.
 *
 * - no HTTP status (network error, timeout, bad payload) -> 502
 * - a status the BFF contract declares for this route -> same status, generic message
 * - any other status, 4xx or 5xx -> 502, so the BFF never answers a status its contract does not declare
 *
 * The upstream message and body are never forwarded: they may leak internals.
 */
export function mapUpstreamError(error: unknown, declaredStatuses: readonly number[] = []): HttpError {
  if (error instanceof HttpError) return error;
  const status = upstreamStatus(error);
  if (status !== undefined && status >= 400 && status < 500 && declaredStatuses.includes(status)) {
    return new HttpError(status);
  }
  return new HttpError(502);
}

/** Reads `status` or `response.status` (axios shape) when it is an HTTP error status. */
export function upstreamStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
  const value = typeof status === 'number' ? status : response?.status;
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined;
}
