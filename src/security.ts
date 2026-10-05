import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { bearerToken } from './auth';
import { defaultMessage } from './error-codes';
import { buildErrorResponse } from './errors';

/**
 * Security headers (CSP, X-Content-Type-Options, Permissions-Policy, CORP, ...) and removal of
 * X-Powered-By, identical in every BFF. `upgrade-insecure-requests` is dropped because the BFFs are
 * served over HTTP behind the reverse proxy. Mount first: `app.use(securityHeaders)`.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'upgrade-insecure-requests': null },
  },
});

/**
 * Stricter headers for the JSON API surface (`default-src 'none'`, no embedding), on every path except
 * the interactive documentation (`/docs` by default), which needs scripts and styles. Mount after
 * `securityHeaders` and before body parsing, so it also covers body-parse errors.
 */
export function apiOnlyHeaders(docsPath = '/docs'): RequestHandler {
  return (req, res, next) => {
    if (!req.path.startsWith(docsPath)) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
    next();
  };
}

/**
 * Rate-limit key part identifying the caller's session: a SHA-256 of its Bearer token (empty without
 * one). Unlike a `sub` decoded without verification, a caller cannot choose it to use or exhaust another
 * user's counter.
 */
export function sessionKey(req: Pick<Request, 'headers'>): string {
  const token = bearerToken(req);
  return token === undefined ? '' : createHash('sha256').update(token).digest('hex');
}

export interface RateLimiterOptions {
  /** Prefix of the environment variables `<prefix>_ENABLED`, `<prefix>_WINDOW_MS`, `<prefix>_MAX`. Default `RATE_LIMIT`. */
  envPrefix?: string;
  /** Window length in ms. Default: `<prefix>_WINDOW_MS` or 15 minutes. */
  windowMs?: number;
  /** Requests allowed per key and window. Default: `<prefix>_MAX` or 10. */
  limit?: number;
  /** Only count failed requests: right for sign-in routes. Default true. */
  failedOnly?: boolean;
  /** With `failedOnly`, which answers count as successes. Default: status < 400. */
  succeeded?: (req: Request, res: Response) => boolean;
  /** Extra key part (account e-mail, `sessionKey`...) appended to the client IP. */
  keyOf?: (req: Request) => string;
  /** Disabled when false. Default: `<prefix>_ENABLED` is not `false`. */
  enabled?: boolean;
  /** Message of the 429. Default `Too many requests`. */
  message?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Rate limiter answering 429 in the shared error envelope, with `RateLimit` and `Retry-After` headers.
 * The key is the client IP (`req.ip`: set `trust proxy` with `parseTrustProxy` behind the ingress), plus
 * `keyOf(req)` when given. Counters live in memory, per replica.
 *
 * `router.post('/login', createRateLimiter({ envPrefix: 'AUTH_RATE_LIMIT', keyOf: (req) => req.body?.email ?? '' }), handler)`
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RequestHandler {
  const prefix = options.envPrefix ?? 'RATE_LIMIT';
  const enabled = options.enabled ?? process.env[`${prefix}_ENABLED`]?.trim().toLowerCase() !== 'false';
  const { keyOf, succeeded } = options;

  return rateLimit({
    windowMs: options.windowMs ?? positiveInteger(process.env[`${prefix}_WINDOW_MS`], 15 * 60 * 1000),
    limit: options.limit ?? positiveInteger(process.env[`${prefix}_MAX`], 10),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: options.failedOnly ?? true,
    ...(succeeded ? { requestWasSuccessful: succeeded } : {}),
    skip: () => !enabled,
    keyGenerator: (req) => {
      const ip = ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
      return keyOf ? `${ip}|${keyOf(req).trim().toLowerCase()}` : ip;
    },
    message: buildErrorResponse('TOO_MANY_REQUESTS', options.message ?? defaultMessage('TOO_MANY_REQUESTS')),
  });
}
