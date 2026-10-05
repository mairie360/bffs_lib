import type { Request } from 'express';
import { authorization } from './auth';
import { baseUrl } from './config';
import { HttpError } from './errors';

/** Default timeout of an upstream call, in ms. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Turns a failed upstream call (generated client, axios, fetch wrapper) into the error the BFF answers with.
 *
 * - no HTTP status (network error, timeout, bad payload) -> 502
 * - a status the BFF contract declares for this route -> same status, generic message
 * - any other status, 4xx or 5xx -> 502, so the BFF never answers a status its contract does not declare
 *
 * The upstream message and body are never forwarded: they may leak internals. The original error is
 * kept as `cause` for the server logs.
 */
export function mapUpstreamError(error: unknown, declaredStatuses: readonly number[] = []): HttpError {
  if (error instanceof HttpError) return error;
  const status = upstreamStatus(error);
  if (status !== undefined && status >= 400 && status < 500 && declaredStatuses.includes(status)) {
    return new HttpError(status, undefined, { cause: error });
  }
  return new HttpError(502, undefined, { cause: error });
}

/** Reads `status` or `response.status` (axios shape) when it is an HTTP error status. */
export function upstreamStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
  const value = typeof status === 'number' ? status : response?.status;
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined;
}

/** True for an axios error that never got an answer (connection refused, DNS, timeout, aborted). */
function isUnanswered(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { isAxiosError, response } = error as { isAxiosError?: unknown; response?: unknown };
  return isAxiosError === true && response === undefined;
}

function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

/**
 * `mapUpstreamError` with a message naming the service, for a failed call to `service` (e.g. `CORE_API`):
 * - `HttpError` (a 401 from `authorization`, a 503 from `baseUrl`...) -> unchanged
 * - no answer (network error, timeout) -> 502 `The <service> service is unavailable.`
 * - an answer the BFF could not parse (`ZodError`) -> 502 `The <service> answer is invalid.`
 * - otherwise -> `mapUpstreamError(error, declared)`
 */
export function upstreamError(service: string, error: unknown, declared: readonly number[] = []): HttpError {
  if (error instanceof HttpError) return error;
  if (isUnanswered(error)) return new HttpError(502, `The ${service} service is unavailable.`, { cause: error });
  if (isZodError(error)) return new HttpError(502, `The ${service} answer is invalid.`, { cause: error });
  return mapUpstreamError(error, declared);
}

export interface RetryOptions {
  /** Extra attempts after the first one. Default 1. */
  retries?: number;
  /** Delay before each extra attempt, in ms. Default 200. */
  delayMs?: number;
}

/** A failure worth retrying: no answer at all, or a 502/503/504 from the upstream. */
function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return false;
  if (isUnanswered(error)) return true;
  const status = upstreamStatus(error);
  return status === 502 || status === 503 || status === 504;
}

/**
 * Runs `call` again on a transient failure (no answer, 502, 503, 504). **Idempotent calls only**
 * (GET, PUT, DELETE): a retried POST may be applied twice upstream.
 */
export async function withRetry<T>(call: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? 200;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= retries || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export interface CallUpstreamOptions {
  /** Upstream 4xx the route declares in its contract and relays as is; anything else becomes a 502. */
  declared?: readonly number[];
  /** Retry transient failures: set only for idempotent calls (see `withRetry`). */
  retry?: RetryOptions | boolean;
}

/**
 * Runs an upstream call and turns any failure into the `HttpError` to answer (see `upstreamError`):
 * `const { data } = await callUpstream('CORE_API', () => coreApi.getMe(asCaller('CORE_API', req)), { declared: [404] });`
 */
export async function callUpstream<T>(service: string, call: () => Promise<T>, options: CallUpstreamOptions = {}): Promise<T> {
  const retry = options.retry === true ? {} : options.retry || undefined;
  try {
    return retry ? await withRetry(call, retry) : await call();
  } catch (error) {
    throw upstreamError(service, error, options.declared);
  }
}

/** Options of an upstream call, structurally compatible with axios' `AxiosRequestConfig`. */
export interface UpstreamRequestOptions {
  baseURL: string;
  timeout: number;
  headers?: Record<string, string>;
}

/**
 * Options of a call to `service` on behalf of the caller: base URL read now (see `baseUrl`) and the
 * caller's Bearer token. The session is checked first, so a caller without one gets a 401 even when the
 * service is not configured.
 */
export function asCaller(service: string, req: Pick<Request, 'headers'>, timeout = UPSTREAM_TIMEOUT_MS): UpstreamRequestOptions {
  const Authorization = authorization(req);
  return { baseURL: baseUrl(service), timeout, headers: { Authorization } };
}

/** Options of a call to `service` without a session (availability probes, sign-in). */
export function withoutSession(service: string, timeout = UPSTREAM_TIMEOUT_MS): UpstreamRequestOptions {
  return { baseURL: baseUrl(service), timeout };
}
