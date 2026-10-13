import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { INVALID_SESSION_MESSAGE, bearerToken } from './auth';
import { HttpError } from './errors';

/**
 * Session tokens verified by the BFF itself (MAIR-474).
 *
 * Every session token a BFF receives is a Core API session JWT: HS256, signed with the `JWT_SECRET`
 * every service shares (a Keycloak sign-in also ends with a Core session token). Verifying it here
 * refuses a forged token with a 401 before any upstream call, and gives the handlers a caller id
 * they can trust, instead of the unverified `sub` of `unverifiedSubject`.
 *
 * The checks are Core's (`mairie360_api_lib`): HS256 only, the signature computed with the bytes of
 * `JWT_SECRET`, `exp` in the future with no leeway, a positive integer `sub`. Whether the session was
 * revoked or the account archived is only known upstream: the token still goes to the API.
 */

/** Message of the 401 answered for a malformed, forged or expired token. */
export const INVALID_TOKEN_MESSAGE = 'Invalid or expired session token.';

/** Message of the 503 answered when the instance has no `JWT_SECRET`. */
export const SESSION_NOT_CONFIGURED_MESSAGE = 'The session check is not configured.';

/** Claims of a verified session token the BFFs use. */
export interface VerifiedSession {
  /** Id of the caller (`users.id`), from the `sub` claim. */
  userId: number;
  /** Expiry of the token, in seconds since the epoch. */
  expiresAt: number;
  /**
   * Name of the caller's role, from the `role` claim Core signs (MAIR-529), or `undefined` when the claim is
   * missing or empty (a token issued before it, or a user with no role): the BFF then reads it from Core API.
   */
  role?: string;
}

/** The `role` claim when it is a non-blank string, trimmed; `undefined` otherwise. */
function roleClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const role = value.trim();
  return role === '' ? undefined : role;
}

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

/**
 * Verifies a session token (without its `Bearer ` prefix) against `secret`.
 * Throws a 401 `HttpError` when it is malformed, not HS256, badly signed, expired or has no
 * positive integer `sub`; never says which check failed.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedSession {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const [encodedHeader, encodedPayload, signature] = parts;
    const header = decodePart(encodedHeader);
    if (header.alg !== 'HS256') throw new Error('not HS256');
    const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('bad signature');

    const payload = decodePart(encodedPayload);
    const { exp, sub } = payload;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) throw new Error('expired');
    const userId = typeof sub === 'string' && /^\d+$/.test(sub) ? Number(sub) : sub;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('bad sub');
    const role = roleClaim(payload.role);
    return role === undefined ? { userId, expiresAt: exp } : { userId, expiresAt: exp, role };
  } catch {
    // Never send the parsing detail (base64, JSON, which check failed) to the client.
    throw new HttpError(401, INVALID_TOKEN_MESSAGE);
  }
}

const sessions = new WeakMap<Request, VerifiedSession>();

/**
 * Middleware verifying the session token of every request: `router.use(requireSession)`.
 * Answers 401 without a Bearer token or with an invalid one, 503 when `JWT_SECRET` is not set (read on
 * every call, like the other settings); otherwise records the session for `sessionUserId`.
 */
export const requireSession: RequestHandler = (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (token === undefined) throw new HttpError(401, INVALID_SESSION_MESSAGE);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new HttpError(503, SESSION_NOT_CONFIGURED_MESSAGE);
    sessions.set(req, verifySessionToken(token, secret));
    next();
  } catch (error) {
    next(error);
  }
};

/** The session `requireSession` verified for this request, or `undefined` when it did not run. */
export function verifiedSession(req: Request): VerifiedSession | undefined {
  return sessions.get(req);
}

/**
 * The caller's id, verified by `requireSession`. Throws a 401 when the request did not go through it, so
 * a route mounted without the middleware fails closed instead of trusting an unverified claim.
 */
export function sessionUserId(req: Request): number {
  const session = sessions.get(req);
  if (session === undefined) throw new HttpError(401, INVALID_SESSION_MESSAGE);
  return session.userId;
}

/**
 * The caller's role from the verified token (`role` claim), or `undefined` when the token carries none and the
 * role must be read from Core API (`GET /api/v1/user/me/`), never from another BFF (MAIR-525). Throws a 401 when
 * the request did not go through `requireSession`.
 */
export function sessionRole(req: Request): string | undefined {
  const session = sessions.get(req);
  if (session === undefined) throw new HttpError(401, INVALID_SESSION_MESSAGE);
  return session.role;
}
