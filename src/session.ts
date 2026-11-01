import { createHash, createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { INVALID_SESSION_MESSAGE, bearerToken } from './auth';
import { HttpError } from './errors';

/**
 * Session tokens verified by the BFF itself (MAIR-474, MAIR-680).
 *
 * Every session token a BFF receives is a Core API session JWT (a Keycloak sign-in also ends with a Core session
 * token). Verifying it here refuses a forged token with a 401 before any upstream call, and gives the handlers a
 * caller id they can trust, instead of the unverified `sub` of `unverifiedSubject`.
 *
 * Since MAIR-680 only Core can sign: it signs with an Ed25519 private key (`alg` EdDSA, `kid` = RFC 7638 thumbprint
 * of its public key, `iss` {@link SESSION_JWT_ISSUER}, `aud` {@link SESSION_JWT_AUDIENCE}) and the BFFs only hold
 * the public key(s), in `JWT_PUBLIC_KEY` (PEM, several `PUBLIC KEY` blocks during a key rotation). The historical
 * HS256 tokens signed with the shared `JWT_SECRET` stay accepted only while `JWT_SECRET` is set (transition): once
 * it is removed, they are refused. The checks are Core's (`mairie360_api_lib`): `exp` in the future with no leeway,
 * a positive integer `sub`. Whether the session was revoked or the account archived is only known upstream: the
 * token still goes to the API.
 */

/** Message of the 401 answered for a malformed, forged or expired token. */
export const INVALID_TOKEN_MESSAGE = 'Invalid or expired session token.';

/** Message of the 503 answered when the instance has neither `JWT_PUBLIC_KEY` nor `JWT_SECRET`. */
export const SESSION_NOT_CONFIGURED_MESSAGE = 'The session check is not configured.';

/** `iss` claim of the session tokens Core signs with its Ed25519 key. */
export const SESSION_JWT_ISSUER = 'mairie360-core';

/** `aud` claim of the session tokens Core signs with its Ed25519 key: every API and BFF of the platform. */
export const SESSION_JWT_AUDIENCE = 'mairie360';

/** Keys a BFF verifies session tokens with. */
export interface SessionKeys {
  /** Core's Ed25519 public keys, by `kid` (RFC 7638 thumbprint). */
  publicKeys: ReadonlyMap<string, KeyObject>;
  /** The historical shared secret: HS256 tokens are only accepted while it is set. */
  secret?: string;
}

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

const PUBLIC_KEY_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g;

/**
 * Parses Core's Ed25519 public keys from PEM text (several `PUBLIC KEY` blocks allowed; line breaks escaped as `\n`,
 * as environment files often do, are accepted), keyed by their RFC 7638 thumbprint, the `kid` of the tokens they
 * verify. Throws when no block is found or one block is not an Ed25519 public key.
 */
export function parseSessionPublicKeys(pem: string): Map<string, KeyObject> {
  const blocks = pem.replace(/\\n/g, '\n').match(PUBLIC_KEY_BLOCK) ?? [];
  if (blocks.length === 0) throw new Error('JWT_PUBLIC_KEY holds no PUBLIC KEY PEM block');
  const keys = new Map<string, KeyObject>();
  for (const block of blocks) {
    const key = createPublicKey(block);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('JWT_PUBLIC_KEY holds a key that is not Ed25519');
    const { x } = key.export({ format: 'jwk' });
    const thumbprint = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');
    keys.set(thumbprint, key);
  }
  return keys;
}

let cachedKeys: { publicPem: string; secret: string; keys: SessionKeys } | undefined;

/**
 * The session keys of the environment: `JWT_PUBLIC_KEY` (parsed once per value) and `JWT_SECRET`. `undefined` when
 * neither is set. Throws when `JWT_PUBLIC_KEY` is set but malformed.
 */
export function sessionKeysFromEnv(env: NodeJS.ProcessEnv = process.env): SessionKeys | undefined {
  const publicPem = env.JWT_PUBLIC_KEY?.trim() ?? '';
  // A blank secret is no secret: it must never become an HMAC key anybody can sign with.
  const secret = env.JWT_SECRET?.trim() ? env.JWT_SECRET : '';
  if (publicPem === '' && secret === '') return undefined;
  if (cachedKeys?.publicPem !== publicPem || cachedKeys.secret !== secret) {
    const keys: SessionKeys = {
      publicKeys: publicPem === '' ? new Map() : parseSessionPublicKeys(publicPem),
      ...(secret === '' ? {} : { secret }),
    };
    cachedKeys = { publicPem, secret, keys };
  }
  return cachedKeys.keys;
}

function checkSignature(header: Record<string, unknown>, unsigned: string, signature: string, keys: SessionKeys) {
  const received = Buffer.from(signature, 'base64url');
  if (header.alg === 'EdDSA') {
    const key = typeof header.kid === 'string' ? keys.publicKeys.get(header.kid) : undefined;
    if (key === undefined) throw new Error('unknown key');
    if (!verify(null, Buffer.from(unsigned), key, received)) throw new Error('bad signature');
    return;
  }
  if (header.alg === 'HS256' && keys.secret?.trim()) {
    const expected = createHmac('sha256', Buffer.from(keys.secret, 'utf8')).update(unsigned).digest();
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('bad signature');
    return;
  }
  throw new Error('algorithm not accepted');
}

/**
 * Verifies a session token (without its `Bearer ` prefix) against `keys` (a bare string is the historical
 * `JWT_SECRET`). Throws a 401 `HttpError` when it is malformed, signed with an algorithm or a key that is not
 * accepted, badly signed, expired, has no positive integer `sub`, or (EdDSA) has another `iss` or `aud`; never says
 * which check failed.
 */
export function verifySessionToken(
  token: string,
  keys: SessionKeys | string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedSession {
  const sessionKeys: SessionKeys = typeof keys === 'string' ? { publicKeys: new Map(), secret: keys } : keys;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const [encodedHeader, encodedPayload, signature] = parts;
    const header = decodePart(encodedHeader);
    checkSignature(header, `${encodedHeader}.${encodedPayload}`, signature, sessionKeys);

    const payload = decodePart(encodedPayload);
    if (header.alg === 'EdDSA') {
      const { aud, iss } = payload;
      const audiences = Array.isArray(aud) ? aud : [aud];
      if (iss !== SESSION_JWT_ISSUER || !audiences.includes(SESSION_JWT_AUDIENCE)) throw new Error('foreign token');
    }
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
 * Answers 401 without a Bearer token or with an invalid one, 503 when neither `JWT_PUBLIC_KEY` nor `JWT_SECRET` is
 * set or `JWT_PUBLIC_KEY` is malformed (read on every call, like the other settings); otherwise records the session
 * for `sessionUserId`.
 */
export const requireSession: RequestHandler = (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (token === undefined) throw new HttpError(401, INVALID_SESSION_MESSAGE);
    let keys: SessionKeys | undefined;
    try {
      keys = sessionKeysFromEnv();
    } catch {
      keys = undefined;
    }
    if (keys === undefined) throw new HttpError(503, SESSION_NOT_CONFIGURED_MESSAGE);
    sessions.set(req, verifySessionToken(token, keys));
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
