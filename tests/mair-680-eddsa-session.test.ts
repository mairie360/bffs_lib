import { createHash, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  INVALID_TOKEN_MESSAGE,
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_ISSUER,
  errorHandler,
  parseSessionPublicKeys,
  requireSession,
  sessionKeysFromEnv,
  sessionUserId,
  verifySessionToken,
  type SessionKeys,
} from '../src';
import {
  CORE_KID,
  CORE_PRIVATE_KEY,
  CORE_PUBLIC_KEY,
  OTHER_PRIVATE_KEY,
  OTHER_PUBLIC_KEY,
  kidOf,
  signEd,
  signHs,
} from './support/session-keys';

// MAIR-680: only Core signs session tokens, with an Ed25519 key; the BFFs hold its public key only.
/** The shared HS256 secret of the transition: it must verify nothing any more. */
const OLD_SECRET = 'session-test-secret-0123456789abcdef';
const NOW = 1_800_000_000;

const claims = (extra: object = {}) => ({
  sub: '2', role: 'Admin', exp: NOW + 3600, iss: SESSION_JWT_ISSUER, aud: SESSION_JWT_AUDIENCE, ...extra,
});
const publicOnly: SessionKeys = { publicKeys: parseSessionPublicKeys(CORE_PUBLIC_KEY) };

describe('MAIR-680 Ed25519 session tokens', () => {
  it('accepts a token Core signed with its key', () => {
    expect(verifySessionToken(signEd(claims()), publicOnly, NOW)).toEqual({ userId: 2, expiresAt: NOW + 3600, role: 'Admin' });
    expect(verifySessionToken(signEd(claims({ aud: ['other', SESSION_JWT_AUDIENCE] })), publicOnly, NOW).userId).toBe(2);
  });

  it.each([
    ['another key claiming Core kid', signEd(claims(), { privatePem: OTHER_PRIVATE_KEY })],
    ['another key with its own kid', signEd(claims(), { privatePem: OTHER_PRIVATE_KEY, header: { alg: 'EdDSA', kid: kidOf(OTHER_PUBLIC_KEY) } })],
    ['no kid', signEd(claims(), { header: { alg: 'EdDSA' } })],
    ['another issuer', signEd(claims({ iss: 'another-issuer' }))],
    ['another audience', signEd(claims({ aud: 'n8n' }))],
    ['no iss nor aud', signEd({ sub: '2', exp: NOW + 3600 })],
    ['expired', signEd(claims({ exp: NOW }))],
    ['HS256 signed with the public key', signHs(claims(), Buffer.from(CORE_PUBLIC_KEY))],
    ['HS256 with the old secret', signHs({ sub: '2', exp: NOW + 3600 }, OLD_SECRET)],
  ])('refuses %s with a 401', (_label, token) => {
    expect(() => verifySessionToken(token, publicOnly, NOW)).toThrow(
      expect.objectContaining({ status: 401, message: INVALID_TOKEN_MESSAGE }),
    );
  });

  it('ignores JWT_SECRET: it neither verifies HS256 nor replaces the public key', () => {
    expect(sessionKeysFromEnv({ JWT_SECRET: OLD_SECRET })).toBeUndefined();
    const keys = sessionKeysFromEnv({ JWT_PUBLIC_KEY: CORE_PUBLIC_KEY, JWT_SECRET: OLD_SECRET });
    expect(keys).toEqual({ publicKeys: expect.any(Map) });
    const legacy = signHs({ sub: '2', role: 'Admin', exp: NOW + 3600 }, OLD_SECRET);
    expect(() => verifySessionToken(legacy, keys as SessionKeys, NOW)).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('accepts every published key during a rotation', () => {
    const both: SessionKeys = { publicKeys: parseSessionPublicKeys(`${OTHER_PUBLIC_KEY}${CORE_PUBLIC_KEY}`) };
    const next = signEd(claims(), { privatePem: OTHER_PRIVATE_KEY, header: { alg: 'EdDSA', kid: kidOf(OTHER_PUBLIC_KEY) } });
    expect(verifySessionToken(signEd(claims()), both, NOW).userId).toBe(2);
    expect(verifySessionToken(next, both, NOW).userId).toBe(2);
  });

  it('identifies keys by their RFC 7638 thumbprint, like mairie360_api_lib', () => {
    // RFC 8037 appendix A.3.
    const rfc = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----';
    expect(kidOf(rfc)).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
    expect(CORE_KID).toBe(createHash('sha256')
      .update('{"crv":"Ed25519","kty":"OKP","x":"KW8bV4kiFUo8hmOEU3-lXdqZL1wmKvBw6smUyjpmXks"}').digest('base64url'));
  });

  it('parses escaped line breaks and refuses what is not an Ed25519 public key', () => {
    expect(kidOf(CORE_PUBLIC_KEY.replace(/\n/g, '\\n'))).toBe(CORE_KID);
    expect(() => parseSessionPublicKeys('not a key')).toThrow();
    expect(() => parseSessionPublicKeys(CORE_PRIVATE_KEY)).toThrow();
    // A valid public key of another type (ES256 here) is not Core's Ed25519 key.
    const { publicKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => parseSessionPublicKeys(ecKey.export({ type: 'spki', format: 'pem' }).toString())).toThrow(/not Ed25519/);
  });

  it('reads the keys from the environment', () => {
    expect(sessionKeysFromEnv({})).toBeUndefined();
    expect(sessionKeysFromEnv({ JWT_PUBLIC_KEY: CORE_PUBLIC_KEY })?.publicKeys.has(CORE_KID)).toBe(true);
    expect(() => sessionKeysFromEnv({ JWT_PUBLIC_KEY: 'garbage' })).toThrow();
  });
});

describe('MAIR-680 requireSession on a BFF holding only the public key', () => {
  const app = express();
  app.get('/private', requireSession, (req, res) => res.json({ userId: sessionUserId(req) }));
  app.use(errorHandler({ onError: jest.fn() }));
  const now = () => Math.floor(Date.now() / 1000);

  afterEach(() => {
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_SECRET;
  });

  it('lets a Core token through and refuses a forged Admin token and an old HS256 token, even with JWT_SECRET left set', async () => {
    process.env.JWT_PUBLIC_KEY = CORE_PUBLIC_KEY;
    process.env.JWT_SECRET = OLD_SECRET;
    const genuine = signEd(claims({ sub: '7', exp: now() + 3600 }));
    const forged = signEd(claims({ sub: '1', exp: now() + 3600 }), { privatePem: OTHER_PRIVATE_KEY });
    const legacy = signHs({ sub: '1', role: 'Admin', exp: now() + 3600 }, OLD_SECRET);
    const res = await request(app).get('/private').set('Authorization', `Bearer ${genuine}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(7);
    expect((await request(app).get('/private').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    expect((await request(app).get('/private').set('Authorization', `Bearer ${legacy}`)).status).toBe(401);
  });

  it('answers 503 when JWT_PUBLIC_KEY is malformed or missing, even with JWT_SECRET set', async () => {
    process.env.JWT_SECRET = OLD_SECRET;
    const legacy = signHs({ sub: '1', exp: now() + 3600 }, OLD_SECRET);
    expect((await request(app).get('/private').set('Authorization', `Bearer ${legacy}`)).status).toBe(503);
    process.env.JWT_PUBLIC_KEY = 'garbage';
    const token = signEd(claims({ exp: now() + 3600 }));
    expect((await request(app).get('/private').set('Authorization', `Bearer ${token}`)).status).toBe(503);
  });
});
