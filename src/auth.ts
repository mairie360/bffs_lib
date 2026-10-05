import type { Request, RequestHandler } from 'express';
import { HttpError } from './errors';

/**
 * The only credential a BFF accepts: `Authorization: Bearer <token>`. The fronts' proxy turns the
 * `accessToken` cookie into this header, so cookies, `x-session-token` and other schemes are ignored.
 */
const BEARER = /^Bearer[ \t]+(\S+)$/i;

export const INVALID_SESSION_MESSAGE = 'Invalid session.';

/** The token of a `Bearer` authorization header, or `undefined` when it is missing or uses another scheme. */
export function bearerToken(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return BEARER.exec(header.trim())?.[1];
}

/**
 * The caller's `Authorization` header to forward upstream, normalised to `Bearer <token>`.
 * Throws a 401 `HttpError` when the request carries no Bearer token, before any upstream call.
 */
export function authorization(req: Pick<Request, 'headers'>): string {
  const token = bearerToken(req);
  if (token === undefined) throw new HttpError(401, INVALID_SESSION_MESSAGE);
  return `Bearer ${token}`;
}

/** Middleware refusing with a 401 every request without a Bearer token: `router.use(requireBearer)`. */
export const requireBearer: RequestHandler = (req, _res, next) => {
  try {
    authorization(req);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * The numeric `sub` claim of a JWT, read **without verifying the signature**, or `undefined` when it
 * cannot be read. Accepts a raw token or a `Bearer <token>` header value.
 *
 * Only use it to shape a request that is then sent upstream with the same token (the upstream
 * verifies it). Never use it to grant access, as a rate-limit key or for anything the caller could
 * abuse by forging the claim.
 */
export function unverifiedSubject(tokenOrHeader: string | undefined): number | undefined {
  if (!tokenOrHeader) return undefined;
  const token = tokenOrHeader.trim().replace(/^Bearer[ \t]+/i, '');
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown };
    const id = typeof sub === 'string' && /^\d+$/.test(sub) ? Number(sub) : sub;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Session-bound answers must never be cached by a proxy or the browser: mount in front of such routers. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * Parses `TRUST_PROXY` into Express' `trust proxy` setting: unset or `false` -> no proxy trusted
 * (default), `true` -> every hop, an integer -> number of trusted hops, anything else ->
 * comma-separated trusted addresses/subnets (e.g. `loopback, 10.0.0.0/8`). Behind the ingress, set
 * it so that `req.ip` (and therefore the rate limits) is the real client, not the proxy:
 * `app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))`.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'false') return false;
  if (trimmed.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
