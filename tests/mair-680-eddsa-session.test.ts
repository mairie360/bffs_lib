import { createHash, createHmac, createPrivateKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
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

// MAIR-680: only Core signs session tokens, with an Ed25519 key; the BFFs hold its public key only.
// Same test key pairs as mairie360_api_lib (`http_setup::TEST_JWT_*`), so tokens are interchangeable.
const CORE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB0n4h8LIrWP97xwhhjiuwTUvTF3l1E0MlDPQdPtlWcN
-----END PRIVATE KEY-----
`;
const CORE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKW8bV4kiFUo8hmOEU3+lXdqZL1wmKvBw6smUyjpmXks=
-----END PUBLIC KEY-----
`;
const OTHER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEII1DTYiu+dcwBgtEKil59uTH8s7XfrxGrbD+/P0sXq/8
-----END PRIVATE KEY-----
`;
const OTHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtZHz1BNkijjkLJlnK9l7vikDl0aivrmbwllpT68Lnss=
-----END PUBLIC KEY-----
`;
const SECRET = 'session-test-secret-0123456789abcdef';
const NOW = 1_800_000_000;

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const kidOf = (publicPem: string) => [...parseSessionPublicKeys(publicPem).keys()][0];
const CORE_KID = kidOf(CORE_PUBLIC_KEY);

function signEd(payload: unknown, { privatePem = CORE_PRIVATE_KEY, header = { alg: 'EdDSA', typ: 'JWT', kid: CORE_KID } as object } = {}) {
  const unsigned = `${part(header)}.${part(payload)}`;
  return `${unsigned}.${edSign(null, Buffer.from(unsigned), createPrivateKey(privatePem)).toString('base64url')}`;
}

function signHs(payload: unknown, secret: string | Buffer = SECRET) {
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

const claims = (extra: object = {}) => ({
  sub: '2', role: 'Admin', exp: NOW + 3600, iss: SESSION_JWT_ISSUER, aud: SESSION_JWT_AUDIENCE, ...extra,
});
const publicOnly: SessionKeys = { publicKeys: parseSessionPublicKeys(CORE_PUBLIC_KEY) };
const transition: SessionKeys = { ...publicOnly, secret: SECRET };

describe('MAIR-680 Ed25519 session tokens', () => {
  it('accepts a token Core signed with its key', () => {
    expect(verifySessionToken(signEd(claims()), publicOnly, NOW)).toEqual({ userId: 2, expiresAt: NOW + 3600, role: 'Admin' });
    expect(verifySessionToken(signEd(claims({ aud: ['other', SESSION_JWT_AUDIENCE] })), publicOnly, NOW).userId).toBe(2);
  });

  it.each([
    ['another key claiming Core kid', signEd(claims(), { privatePem: OTHER_PRIVATE_KEY })],
    ['another key with its own kid', signEd(claims(), { privatePem: OTHER_PRIVATE_KEY, header: { alg: 'EdDSA', kid: kidOf(OTHER_PUBLIC_KEY) } })],
    ['no kid', signEd(claims(), { header: { alg: 'EdDSA' } })],
    ['another issuer', signEd(claims({ iss: 'keycloak' }))],
    ['another audience', signEd(claims({ aud: 'n8n' }))],
    ['no iss nor aud', signEd({ sub: '2', exp: NOW + 3600 })],
    ['expired', signEd(claims({ exp: NOW }))],
    ['HS256 signed with the public key', signHs(claims(), Buffer.from(CORE_PUBLIC_KEY))],
    ['HS256 with the old secret, once the secret is removed', signHs({ sub: '2', exp: NOW + 3600 })],
  ])('refuses %s with a 401', (_label, token) => {
    expect(() => verifySessionToken(token, publicOnly, NOW)).toThrow(
      expect.objectContaining({ status: 401, message: INVALID_TOKEN_MESSAGE }),
    );
  });

  it('keeps accepting HS256 tokens while JWT_SECRET is still set (transition)', () => {
    expect(verifySessionToken(signHs({ sub: '2', exp: NOW + 3600 }), transition, NOW).userId).toBe(2);
    expect(verifySessionToken(signEd(claims()), transition, NOW).userId).toBe(2);
  });

  it.each(['', '   '])('never verifies HS256 with a blank secret (%j)', (blank) => {
    const forged = signHs({ sub: '1', role: 'Admin', exp: NOW + 3600 }, blank);
    expect(() => verifySessionToken(forged, { ...publicOnly, secret: blank }, NOW)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(sessionKeysFromEnv({ JWT_PUBLIC_KEY: CORE_PUBLIC_KEY, JWT_SECRET: blank })?.secret).toBeUndefined();
    expect(sessionKeysFromEnv({ JWT_SECRET: blank })).toBeUndefined();
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
    expect(sessionKeysFromEnv({ JWT_PUBLIC_KEY: CORE_PUBLIC_KEY })?.secret).toBeUndefined();
    expect(sessionKeysFromEnv({ JWT_PUBLIC_KEY: CORE_PUBLIC_KEY })?.publicKeys.has(CORE_KID)).toBe(true);
    expect(sessionKeysFromEnv({ JWT_SECRET: SECRET })?.publicKeys.size).toBe(0);
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

  it('lets a Core token through and refuses a forged Admin token and an old HS256 token', async () => {
    process.env.JWT_PUBLIC_KEY = CORE_PUBLIC_KEY;
    const genuine = signEd(claims({ sub: '7', exp: now() + 3600 }));
    const forged = signEd(claims({ sub: '1', exp: now() + 3600 }), { privatePem: OTHER_PRIVATE_KEY });
    const legacy = signHs({ sub: '1', role: 'Admin', exp: now() + 3600 });
    const res = await request(app).get('/private').set('Authorization', `Bearer ${genuine}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(7);
    expect((await request(app).get('/private').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    expect((await request(app).get('/private').set('Authorization', `Bearer ${legacy}`)).status).toBe(401);
  });

  it('answers 503 when JWT_PUBLIC_KEY is malformed and no secret is set', async () => {
    process.env.JWT_PUBLIC_KEY = 'garbage';
    const token = signEd(claims({ exp: now() + 3600 }));
    expect((await request(app).get('/private').set('Authorization', `Bearer ${token}`)).status).toBe(503);
  });
});
