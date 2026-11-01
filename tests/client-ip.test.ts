import express from 'express';
import request from 'supertest';
import { CLIENT_IP_HEADER, UPSTREAM_TIMEOUT_MS, asAnonymousClient, clientIp, parseTrustProxy } from '../src';

// MAIR-679: Core rate-limited sign-in and password recovery on the BFF pod's address, shared by every user of the
// instance, because anonymous upstream calls never carried the client address.
describe('MAIR-679 client address relayed to the APIs', () => {
  beforeEach(() => {
    process.env.CORE_API_URL = 'http://core-api:3000';
  });

  it('reads req.ip, else the socket peer, IPv4-mapped addresses in IPv4 form', () => {
    expect(clientIp({ ip: '203.0.113.7', socket: {} as never })).toBe('203.0.113.7');
    expect(clientIp({ ip: '::ffff:203.0.113.7', socket: {} as never })).toBe('203.0.113.7');
    expect(clientIp({ ip: '2001:db8::1', socket: {} as never })).toBe('2001:db8::1');
    expect(clientIp({ ip: undefined, socket: { remoteAddress: '198.51.100.9' } as never })).toBe('198.51.100.9');
    expect(clientIp({ ip: undefined, socket: {} as never })).toBeUndefined();
  });

  it('sends the client address as X-Forwarded-For on an anonymous call', () => {
    expect(asAnonymousClient('CORE_API', { ip: '203.0.113.7', socket: {} as never })).toEqual({
      baseURL: 'http://core-api:3000',
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(asAnonymousClient('CORE_API', { ip: '203.0.113.7', socket: {} as never }, 2_000).timeout).toBe(2_000);
  });

  it('sends no header when the client address is unknown', () => {
    expect(asAnonymousClient('CORE_API', { ip: undefined, socket: {} as never })).toEqual({
      baseURL: 'http://core-api:3000',
      timeout: UPSTREAM_TIMEOUT_MS,
    });
  });

  /** A BFF behind `trust proxy`, answering the header it would send upstream. */
  function bff(trustProxy: string | undefined) {
    const app = express();
    app.set('trust proxy', parseTrustProxy(trustProxy));
    app.get('/relay', (req, res) => {
      res.json(asAnonymousClient('CORE_API', req).headers ?? {});
    });
    return app;
  }

  it('relays the client the trusted proxies saw, not the address the client forged', async () => {
    // The client forged 1.2.3.4; the front (a trusted loopback peer here) appended the real address.
    const response = await request(bff('loopback'))
      .get('/relay')
      .set('X-Forwarded-For', '1.2.3.4, 198.51.100.9');
    expect(response.body).toEqual({ [CLIENT_IP_HEADER]: '198.51.100.9' });
  });

  it('relays the peer, never the forged header, when no proxy is trusted', async () => {
    const response = await request(bff(undefined)).get('/relay').set('X-Forwarded-For', '1.2.3.4');
    expect(response.body[CLIENT_IP_HEADER]).not.toContain('1.2.3.4');
    expect(response.body[CLIENT_IP_HEADER]).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('gives two clients behind the same front two different relayed addresses', async () => {
    const app = bff('loopback');
    const a = await request(app).get('/relay').set('X-Forwarded-For', '198.51.100.1');
    const b = await request(app).get('/relay').set('X-Forwarded-For', '198.51.100.2');
    expect(a.body[CLIENT_IP_HEADER]).toBe('198.51.100.1');
    expect(b.body[CLIENT_IP_HEADER]).toBe('198.51.100.2');
  });
});
