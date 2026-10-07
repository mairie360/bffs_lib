import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  ErrorResponseSchema,
  INVALID_TOKEN_MESSAGE,
  errorHandler,
  requireSession,
  sessionUserId,
  verifiedSession,
  verifySessionToken,
} from '../src';

const SECRET = 'session-test-secret-0123456789abcdef';
const NOW = 1_800_000_000;

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(payload: unknown, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}): string {
  const unsigned = `${part(header)}.${part(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

const genuine = sign({ sub: '2', role: 'user', exp: NOW + 3600 });

/** The tokens an attacker can build without the secret, labelled for the failure message. */
function forgedTokens(): [string, string][] {
  const [header, , signature] = genuine.split('.');
  return [
    ['garbage', 'not.a.jwt'],
    ['two parts', 'abc.def'],
    ['empty signature', `${genuine.split('.').slice(0, 2).join('.')}.`],
    ['other secret', sign({ sub: '2', exp: NOW + 3600 }, { secret: 'not-the-secret' })],
    ['expired', sign({ sub: '2', exp: NOW - 1 })],
    ['expiring now', sign({ sub: '2', exp: NOW })],
    ['no exp', sign({ sub: '2' })],
    ['string exp', sign({ sub: '2', exp: String(NOW + 3600) })],
    ['alg none', `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: '2', exp: NOW + 3600 })}.`],
    ['alg RS256', sign({ sub: '2', exp: NOW + 3600 }, { header: { alg: 'RS256', typ: 'JWT' } })],
    ['swapped payload', `${header}.${part({ sub: '1', role: 'admin', exp: NOW + 3600 })}.${signature}`],
    ['no sub', sign({ exp: NOW + 3600 })],
    ['zero sub', sign({ sub: '0', exp: NOW + 3600 })],
    ['negative sub', sign({ sub: -2, exp: NOW + 3600 })],
    ['non-numeric sub', sign({ sub: 'admin', exp: NOW + 3600 })],
    ['payload not an object', sign([2])],
  ];
}

describe('verifySessionToken', () => {
  it('accepts a genuine token and returns its caller', () => {
    expect(verifySessionToken(genuine, SECRET, NOW)).toEqual({ userId: 2, expiresAt: NOW + 3600 });
    expect(verifySessionToken(sign({ sub: 42, exp: NOW + 1 }), SECRET, NOW).userId).toBe(42);
  });

  it.each(forgedTokens())('refuses a token with %s with a 401, without saying why', (_label, token) => {
    expect(() => verifySessionToken(token, SECRET, NOW)).toThrow(
      expect.objectContaining({ status: 401, message: INVALID_TOKEN_MESSAGE }),
    );
  });
});

describe('requireSession', () => {
  const app = express();
  app.get('/private', requireSession, (req, res) => res.json({ userId: sessionUserId(req), session: verifiedSession(req) }));
  app.get('/unguarded', (req, res) => res.json({ userId: sessionUserId(req) }));
  app.use(errorHandler({ onError: jest.fn() }));
  const fresh = sign({ sub: '7', exp: Math.floor(Date.now() / 1000) + 3600 });

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it('lets a genuine token through and exposes the verified caller', async () => {
    const res = await request(app).get('/private').set('Authorization', `Bearer ${fresh}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(7);
  });

  it.each([
    ['no header', undefined],
    ['another scheme', `Basic ${fresh}`],
    ['a forged token', `Bearer ${sign({ sub: '7', exp: Math.floor(Date.now() / 1000) + 3600 }, { secret: 'other' })}`],
    ['an expired token', `Bearer ${sign({ sub: '7', exp: Math.floor(Date.now() / 1000) - 1 })}`],
  ])('answers 401 in the envelope with %s', async (_label, header) => {
    const req = request(app).get('/private');
    const res = await (header === undefined ? req : req.set('Authorization', header));
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  it('answers 503 when JWT_SECRET is not set, before reading the token', async () => {
    delete process.env.JWT_SECRET;
    const res = await request(app).get('/private').set('Authorization', `Bearer ${fresh}`);
    expect(res.status).toBe(503);
  });

  it('fails closed when a route reads the caller without the middleware', async () => {
    const res = await request(app).get('/unguarded').set('Authorization', `Bearer ${fresh}`);
    expect(res.status).toBe(401);
  });
});
