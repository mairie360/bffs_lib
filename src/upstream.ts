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
 * - a 429 (the upstream rate limit) -> 429 with the upstream `Retry-After` (MAIR-562), declared or not: the BFF's
 *   own rate limiter already answers 429 on every route, and a 502 would hide that the caller only has to wait
 * - a status the BFF contract declares for this route -> same status, generic message
 * - any other status, 4xx or 5xx -> 502, so the BFF never answers a status its contract does not declare
 *
 * The upstream message and body are never forwarded: they may leak internals. The original error is
 * kept as `cause` for the server logs.
 */
export function mapUpstreamError(error: unknown, declaredStatuses: readonly number[] = []): HttpError {
  if (error instanceof HttpError) return error;
  const status = upstreamStatus(error);
  if (status === 429) return new HttpError(429, undefined, { cause: error, retryAfterSeconds: upstreamRetryAfterSeconds(error) ?? 1 });
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

/**
 * `Retry-After` of a failed upstream answer, in whole seconds (rounded up, at least 0), from `headers` or
 * `response.headers` (plain object or axios `AxiosHeaders`). Accepts delay-seconds and HTTP dates; `undefined`
 * when absent or unreadable.
 */
export function upstreamRetryAfterSeconds(error: unknown, now: number = Date.now()): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { headers, response } = error as { headers?: unknown; response?: { headers?: unknown } };
  const raw = headerValue(headers ?? response?.headers, 'retry-after');
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value: unknown = getter.call(headers, name);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value: unknown = Array.isArray(entry?.[1]) ? entry?.[1][0] : entry?.[1];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
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
  /**
   * Longest `Retry-After` of an upstream 429 worth waiting for, in ms (MAIR-562). A longer one is thrown at once,
   * so the client gets the 429 instead of a request hanging. Default 2000.
   */
  maxRetryAfterMs?: number;
}

/** Delay before retrying `error`, or `undefined` when it must be thrown. */
type RetryPolicy = (error: unknown, options: Required<RetryOptions>) => number | undefined;

/** A failure worth retrying: no answer at all, or a 502/503/504 from the upstream. */
function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return false;
  if (isUnanswered(error)) return true;
  const status = upstreamStatus(error);
  return status === 502 || status === 503 || status === 504;
}

/** An upstream 429: the request was refused before being applied, so it is safe to send again, POST included. */
function isRateLimited(error: unknown): boolean {
  return !(error instanceof HttpError) && upstreamStatus(error) === 429;
}

/** Wait of a 429: its `Retry-After` (at least `delayMs`), `undefined` beyond `maxRetryAfterMs`. */
function rateLimitDelay(error: unknown, options: Required<RetryOptions>): number | undefined {
  const retryAfterMs = (upstreamRetryAfterSeconds(error) ?? 0) * 1000;
  return retryAfterMs > options.maxRetryAfterMs ? undefined : Math.max(options.delayMs, retryAfterMs);
}

const transientOrRateLimited: RetryPolicy = (error, options) => {
  if (isRateLimited(error)) return rateLimitDelay(error, options);
  return isTransient(error) ? options.delayMs : undefined;
};

const rateLimitedOnly: RetryPolicy = (error, options) => (isRateLimited(error) ? rateLimitDelay(error, options) : undefined);

async function retrying<T>(call: () => Promise<T>, policy: RetryPolicy, options: RetryOptions): Promise<T> {
  const resolved: Required<RetryOptions> = {
    retries: options.retries ?? 1,
    delayMs: options.delayMs ?? 200,
    maxRetryAfterMs: options.maxRetryAfterMs ?? 2000,
  };
  // Attempts are sequential by nature: the next one only starts when the previous one failed.
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const delay = attempt < resolved.retries ? policy(error, resolved) : undefined;
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  /* eslint-enable no-await-in-loop */
}

/**
 * Runs `call` again on a transient failure (no answer, 502, 503, 504) or an upstream 429 (after its `Retry-After`,
 * see `maxRetryAfterMs`). **Idempotent calls only** (GET, PUT, DELETE): a retried POST may be applied twice
 * upstream after a transient failure. Use `withRateLimitRetry` for the others.
 */
export async function withRetry<T>(call: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  return retrying(call, transientOrRateLimited, options);
}

/**
 * Runs `call` again on an upstream 429 only, after its `Retry-After` (MAIR-562). Safe for any method: a 429 is
 * refused before anything is applied.
 */
export async function withRateLimitRetry<T>(call: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  return retrying(call, rateLimitedOnly, options);
}

export interface CallUpstreamOptions {
  /** Upstream 4xx the route declares in its contract and relays as is; anything else becomes a 502. */
  declared?: readonly number[];
  /** Retry transient failures and 429: set only for idempotent calls (see `withRetry`). */
  retry?: RetryOptions | boolean;
  /**
   * Retry an upstream 429 only, after its `Retry-After` (see `withRateLimitRetry`), for any method. Ignored when
   * `retry` is set, which already covers it.
   */
  retryRateLimited?: RetryOptions | boolean;
}

/**
 * Runs an upstream call and turns any failure into the `HttpError` to answer (see `upstreamError`):
 * `const { data } = await callUpstream('CORE_API', () => coreApi.getMe(asCaller('CORE_API', req)), { declared: [404] });`
 */
export async function callUpstream<T>(service: string, call: () => Promise<T>, options: CallUpstreamOptions = {}): Promise<T> {
  const retry = options.retry === true ? {} : options.retry || undefined;
  const rateLimited = options.retryRateLimited === true ? {} : options.retryRateLimited || undefined;
  try {
    if (retry) return await withRetry(call, retry);
    return rateLimited ? await withRateLimitRetry(call, rateLimited) : await call();
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

/** Header relaying the client address to the APIs (MAIR-679). */
export const CLIENT_IP_HEADER = 'X-Forwarded-For';

/**
 * Address of the client that sent `req`, as Express resolved it: `req.ip`, which only reads `X-Forwarded-For` through
 * the proxies trusted by `trust proxy` (see `parseTrustProxy`), else the socket peer. An IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.7`) is given in its IPv4 form. `undefined` when neither is known.
 */
export function clientIp(req: Pick<Request, 'ip' | 'socket'>): string | undefined {
  const raw = req.ip ?? req.socket?.remoteAddress;
  if (!raw) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  return mapped ? mapped[1] : raw;
}

/**
 * Options of a call to `service` without a session, made on behalf of the anonymous client of `req` (sign-in, password
 * recovery, refresh): the client address is sent as `X-Forwarded-For` so the API rate-limits and audits the client,
 * not the BFF pod shared by every user (MAIR-679). The header holds `clientIp(req)` alone, never the chain the client
 * sent: a forged `X-Forwarded-For` only reaches the API through `trust proxy`, which already discarded it.
 */
export function asAnonymousClient(
  service: string,
  req: Pick<Request, 'ip' | 'socket'> & { app?: Pick<Request['app'], 'get'> },
  timeout = UPSTREAM_TIMEOUT_MS,
): UpstreamRequestOptions {
  const options = withoutSession(service, timeout);
  // `trust proxy` = true (`TRUST_PROXY=true`) trusts every hop: `req.ip` is then the leftmost X-Forwarded-For entry,
  // which the client wrote. Relaying it would let the client pick the address the API rate-limits, so nothing is sent
  // and the API counts this BFF, as before MAIR-679. List the trusted proxies instead (`loopback, 10.42.0.0/16`).
  if (req.app?.get('trust proxy') === true) return options;
  const ip = clientIp(req);
  return ip ? { ...options, headers: { [CLIENT_IP_HEADER]: ip } } : options;
}
