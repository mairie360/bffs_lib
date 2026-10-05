import express from 'express';
import request from 'supertest';
import {
  ErrorResponseSchema,
  authorization,
  bearerToken,
  errorHandler,
  noStore,
  parseTrustProxy,
  requireBearer,
  unverifiedSubject,
} from '../src';

function jwt(payload: unknown): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

const headers = (authorizationHeader?: string) => ({ headers: { authorization: authorizationHeader } });

describe('bearerToken / authorization', () => {
  it('reads the token of a Bearer header, whatever the case of the scheme', () => {
    expect(bearerToken(headers('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
    expect(bearerToken(headers('  bearer   abc  '))).toBe('abc');
    expect(authorization(headers('BEARER abc'))).toBe('Bearer abc');
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b', 'Bearerabc'])(
    'refuses %p with a 401',
    (value) => {
      expect(bearerToken(headers(value))).toBeUndefined();
      expect(() => authorization(headers(value))).toThrow(expect.objectContaining({ status: 401, code: 'UNAUTHORIZED' }));
    },
  );
});

describe('requireBearer', () => {
  const app = express();
  app.get('/private', requireBearer, (req, res) => res.json({ forwarded: authorization(req) }));
  app.use(errorHandler({ onError: jest.fn() }));

  it('lets a Bearer request through', async () => {
    const res = await request(app).get('/private').set('Authorization', 'bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ forwarded: 'Bearer tok' });
  });

  it('answers 401 in the envelope without a Bearer token, ignoring cookies and x-session-token', async () => {
    const res = await request(app)
      .get('/private')
      .set('Cookie', 'accessToken=tok; session=tok')
      .set('x-session-token', 'tok');
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(res.body).error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid session.', details: [] });
  });
});

describe('unverifiedSubject', () => {
  it('reads a positive integer sub from a token or a header', () => {
    expect(unverifiedSubject(jwt({ sub: 2 }))).toBe(2);
    expect(unverifiedSubject(`Bearer ${jwt({ sub: '42' })}`)).toBe(42);
  });

  it.each([
    undefined,
    '',
    'not-a-jwt',
    'a.%%%.c',
    jwt({}),
    jwt({ sub: 0 }),
    jwt({ sub: -1 }),
    jwt({ sub: 1.5 }),
    jwt({ sub: 'abc' }),
    jwt({ user_id: 3 }),
    jwt(null),
  ])('returns undefined for %p', (value) => {
    expect(unverifiedSubject(value)).toBeUndefined();
  });
});

describe('noStore', () => {
  it('marks the answer as not cacheable', async () => {
    const app = express();
    app.get('/me', noStore, (_req, res) => res.json({}));
    const res = await request(app).get('/me');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    [' false ', false],
    ['TRUE', true],
    ['2', 2],
    ['loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
  ])('parses %p', (value, expected) => {
    expect(parseTrustProxy(value)).toBe(expected);
  });
});
