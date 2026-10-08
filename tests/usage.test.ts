import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { USAGE_METRICS_PATH, createUsageLedger, requireSession, usageMetricsHandler, usageMiddleware } from '../src';

const MINUTE = 60_000;
const T0 = 100 * MINUTE;

describe('usage ledger (MAIR-501)', () => {
  it('counts distinct users and never exports a count under the threshold', () => {
    const ledger = createUsageLedger({ service: 'bff-project', periodMs: MINUTE, threshold: 5 });
    for (let user = 1; user <= 6; user += 1) ledger.record('/projects', 'GET', 200, 10, user, T0);
    ledger.record('/projects', 'GET', 200, 10, 3, T0);
    // A rare operation by 2 users: under k = 5, and the `other` bucket (2 actions) too.
    ledger.record('/projects/:id', 'DELETE', 204, 5, 8, T0);
    ledger.record('/projects/:id', 'DELETE', 204, 5, 9, T0);

    expect(ledger.closedEntries(T0)).toEqual([]);
    const entries = ledger.closedEntries(T0 + MINUTE);
    expect(entries).toEqual([
      { service: 'bff-project', operation: '/projects', method: 'GET', status: 200, periodStart: 6000, actions: 7, distinctUsers: 6, latencyMsSum: 70 },
    ]);
  });

  it('sums the small operations into `other` when it reaches the threshold', () => {
    const ledger = createUsageLedger({ service: 'bff', periodMs: MINUTE, threshold: 3 });
    ['/a', '/b', '/c'].forEach((operation, i) => ledger.record(operation, 'GET', 200, 1, i + 1, T0));
    const entries = ledger.closedEntries(T0 + MINUTE);
    expect(entries.map((e) => [e.operation, e.actions, e.distinctUsers])).toEqual([['other', 3, 3]]);
  });

  it('exports no identifier and no hash, and keeps a limited number of periods', () => {
    const ledger = createUsageLedger({ service: 'bff-user', periodMs: MINUTE, threshold: 1, retainedPeriods: 2 });
    for (let p = 0; p < 4; p += 1) ledger.record('/me', 'GET', 200, 3, 987654321, T0 + p * MINUTE);
    const text = ledger.renderPrometheus(T0 + 4 * MINUTE);
    expect(text).toContain('mairie360_usage_distinct_users{service="bff-user",operation="/me",method="GET",status="200"');
    expect(text).not.toContain('987654321');
    expect(text.split(/[^0-9a-f]/).some((word) => word.length >= 32)).toBe(false);
    expect(ledger.closedEntries(T0 + 4 * MINUTE)).toHaveLength(2);
  });

  it('the same user in two periods is never linked: each period counts it once with its own salt', () => {
    const ledger = createUsageLedger({ service: 'bff', periodMs: MINUTE, threshold: 1 });
    ledger.record('/me', 'GET', 200, 1, 7, T0);
    ledger.record('/me', 'GET', 200, 1, 7, T0 + MINUTE);
    const entries = ledger.closedEntries(T0 + 2 * MINUTE);
    expect(entries.map((e) => e.distinctUsers)).toEqual([1, 1]);
    expect(JSON.stringify(ledger)).not.toMatch(/salt|[0-9a-f]{32}/);
  });
});

describe('usage middleware (MAIR-501)', () => {
  const SECRET = 'usage-test-secret-0123456789abcdef';
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: '424242', exp: 4102444800 })}`;
  const token = `${unsigned}.${createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });
  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it('records the route template, never the path, the query or the caller', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    jest.setSystemTime(T0);
    const ledger = createUsageLedger({ service: 'bff-test', periodMs: MINUTE, threshold: 1 });
    const app = express();
    app.use(usageMiddleware(ledger));
    app.get(USAGE_METRICS_PATH, usageMetricsHandler(ledger));
    const router = express.Router();
    router.use(requireSession);
    router.get('/items/:id', (_req, res) => {
      res.sendStatus(200);
    });
    app.use('/api', router);

    await request(app).get('/api/items/123?search=jean.dupont%40example.com').set('Authorization', `Bearer ${token}`).expect(200);
    jest.setSystemTime(T0 + MINUTE);
    const response = await request(app).get(USAGE_METRICS_PATH).expect(200);
    jest.useRealTimers();
    expect(response.text).toContain('operation="/api/items/:id",method="GET",status="200"');
    expect(response.text).toContain('mairie360_usage_distinct_users{service="bff-test",operation="/api/items/:id"');
    expect(response.text).not.toMatch(/items\/123|dupont|424242/);
  });
});
