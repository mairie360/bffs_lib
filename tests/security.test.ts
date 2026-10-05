import { createHash } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { ErrorResponseSchema, apiOnlyHeaders, createRateLimiter, securityHeaders, sessionKey } from '../src';

const ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ENV };
});

describe('securityHeaders / apiOnlyHeaders', () => {
  const app = express();
  app.use(securityHeaders);
  app.use(apiOnlyHeaders());
  app.get(['/docs/index.html', '/health'], (_req, res) => res.json({}));

  it('sets the strict API headers and removes X-Powered-By', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toBe('geolocation=(), camera=(), microphone=()');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps the helmet CSP on the documentation, without upgrade-insecure-requests', async () => {
    const res = await request(app).get('/docs/index.html');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });
});

describe('sessionKey', () => {
  it('hashes the Bearer token and is empty without one', () => {
    expect(sessionKey({ headers: { authorization: 'Bearer tok' } })).toBe(createHash('sha256').update('tok').digest('hex'));
    expect(sessionKey({ headers: {} })).toBe('');
  });
});

function limitedApp(limiter: RequestHandler, status = 401) {
  const app = express();
  app.use(express.json());
  app.post('/login', limiter, (req, res) => {
    res.status(req.body?.status ?? status).json({});
  });
  return app;
}

describe('createRateLimiter', () => {
  it('counts failed requests only and answers 429 in the envelope', async () => {
    const app = limitedApp(createRateLimiter({ limit: 2, windowMs: 60_000 }));
    await request(app).post('/login').send({ status: 200 });
    await request(app).post('/login').send({ status: 200 });
    await request(app).post('/login');
    await request(app).post('/login');
    const res = await request(app).post('/login');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['ratelimit-policy']).toBeDefined();
    expect(ErrorResponseSchema.parse(res.body).error).toEqual({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests', details: [] });
  });

  it('counts every request when failedOnly is false, with a custom message', async () => {
    const app = limitedApp(createRateLimiter({ limit: 1, failedOnly: false, message: 'Slow down' }), 200);
    await request(app).post('/login');
    const res = await request(app).post('/login');
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('Slow down');
  });

  it('lets a custom predicate decide what is a success', async () => {
    const app = limitedApp(createRateLimiter({ limit: 1, succeeded: (_req, res) => res.statusCode < 400 || res.statusCode === 412 }));
    await request(app).post('/login').send({ status: 412 });
    await request(app).post('/login').send({ status: 412 });
    expect((await request(app).post('/login')).status).toBe(401);
    expect((await request(app).post('/login')).status).toBe(429);
  });

  it('keys on the IP plus keyOf', async () => {
    const app = limitedApp(createRateLimiter({ limit: 1, keyOf: (req) => req.body?.email ?? '' }));
    await request(app).post('/login').send({ email: 'A@x.fr' });
    expect((await request(app).post('/login').send({ email: 'a@x.fr ' })).status).toBe(429);
    expect((await request(app).post('/login').send({ email: 'b@x.fr' })).status).toBe(401);
  });

  it('reads its settings from the environment with a prefix', async () => {
    process.env.AUTH_RATE_LIMIT_MAX = '1';
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = 'nonsense';
    const app = limitedApp(createRateLimiter({ envPrefix: 'AUTH_RATE_LIMIT' }));
    await request(app).post('/login');
    const res = await request(app).post('/login');
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-policy']).toContain('w=900');
  });

  it('is disabled by <prefix>_ENABLED=false or the option', async () => {
    process.env.RATE_LIMIT_ENABLED = 'FALSE';
    const fromEnv = limitedApp(createRateLimiter({ limit: 1 }));
    const fromOption = limitedApp(createRateLimiter({ limit: 1, enabled: false }));
    for (const app of [fromEnv, fromOption]) {
      await request(app).post('/login');
      expect((await request(app).post('/login')).status).toBe(401);
    }
  });
});
