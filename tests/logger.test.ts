import { context, trace, TraceFlags } from '@opentelemetry/api';
import express from 'express';
import request from 'supertest';
import { REQUEST_ID_HEADER, createLogger, logger, notFoundHandler, requestId, requestLogger } from '../src';
import { captureLogs } from './support/capture-logs';

const ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

function memoryLogger(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ now: () => Date.UTC(2026, 9, 13, 8, 30), write: (line) => lines.push(JSON.parse(line)), ...options });
  return { log, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per line: timestamp, level, target, message, then the fields', () => {
    const { log, lines } = memoryLogger({ target: 'bff-user' });
    log.info('request completed', { request_id: 'abc', status: 200, cached: false, missing: undefined, none: null });
    expect(lines).toEqual([
      {
        timestamp: '2026-10-13T08:30:00.000Z',
        level: 'INFO',
        target: 'bff-user',
        message: 'request completed',
        request_id: 'abc',
        status: 200,
        cached: false,
        none: null,
      },
    ]);
  });

  it('never lets a field replace the reserved keys nor carry an object', () => {
    const { log, lines } = memoryLogger();
    const body = { password: 'secret' } as unknown as string;
    log.warn('x', { level: 'DEBUG', message: 'other', timestamp: 'never', body, ratio: Number.NaN });
    expect(lines[0]).toEqual({ timestamp: '2026-10-13T08:30:00.000Z', level: 'WARN', target: 'bff', message: 'x', body: '[object]', ratio: 'NaN' });
  });

  it('filters by level: LOG_LEVEL read on every line, info by default, the option first', () => {
    const { log, lines } = memoryLogger();
    log.debug('hidden');
    process.env.LOG_LEVEL = 'WARN';
    log.info('hidden');
    log.error('shown');
    process.env.LOG_LEVEL = 'nonsense';
    log.info('shown');
    const forced = memoryLogger({ level: 'debug' });
    forced.log.debug('shown');
    expect(lines.map((line) => line.message)).toEqual(['shown', 'shown']);
    expect(forced.lines).toHaveLength(1);
  });

  it('builds children carrying their fields and target', () => {
    const { log, lines } = memoryLogger({ target: 'bff-user', fields: { region: 'fr' } });
    const child = log.child({ target: 'bff-user:auth', component: 'auth' });
    child.error('failed', { status: 502 });
    child.child({ step: 1 }).info('again');
    expect(lines[0]).toEqual(expect.objectContaining({ target: 'bff-user:auth', region: 'fr', component: 'auth', status: 502 }));
    expect(lines[1]).toEqual(expect.objectContaining({ target: 'bff-user:auth', component: 'auth', step: 1 }));
  });

  it('adds the trace and span ids of the active span', () => {
    const { log, lines } = memoryLogger();
    const span = trace.wrapSpanContext({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED });
    const withSpan = trace.setSpan(context.active(), span);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(trace.getSpan(withSpan));
    log.info('traced');
    expect(lines[0]).toEqual(expect.objectContaining({ trace_id: '0af7651916cd43dd8448eb211c80319c', span_id: 'b7ad6b7169203331' }));
  });

  it('swallows a failing writer', () => {
    const log = createLogger({ write: () => { throw new Error('EPIPE'); } });
    expect(() => log.error('lost')).not.toThrow();
  });

  it('writes to stdout by default', () => {
    const logs = captureLogs();
    logger.info('hello', { status: 1 });
    jest.restoreAllMocks();
    expect(logs).toEqual([expect.objectContaining({ level: 'INFO', target: 'bff', message: 'hello', status: 1 })]);
  });
});

describe('requestLogger', () => {
  function buildApp(log = memoryLogger()) {
    const app = express();
    app.use(requestLogger({ logger: log.log }));
    const users = express.Router();
    users.get('/:userId', (req, res) => {
      res.json({ id: requestId(req) });
    });
    app.use('/users', users);
    app.get('/health', (_req, res) => res.send('OK'));
    app.get('/boom', (_req, res) => res.status(503).end());
    app.get('/', (_req, res) => res.send('root'));
    app.get('/slow', (_req, res) => {
      setTimeout(() => res.end(), 200);
    });
    app.use(notFoundHandler);
    return { app, lines: log.lines };
  }

  it('writes the method, the route (no id, no query), the status, the duration and the request id', async () => {
    const { app, lines } = buildApp();
    const res = await request(app).get('/users/42?email=someone@example.com');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.id).toBe(res.headers['x-request-id']);
    expect(lines).toEqual([
      expect.objectContaining({ level: 'INFO', message: 'request completed', method: 'GET', path: '/users/:userId', status: 200, request_id: res.headers['x-request-id'] }),
    ]);
    expect(typeof lines[0].duration_ms).toBe('number');
    expect(JSON.stringify(lines)).not.toMatch(/42|example/);
  });

  it('keeps a well-formed incoming request id and replaces any other', async () => {
    const { app } = buildApp();
    const kept = await request(app).get('/').set(REQUEST_ID_HEADER, 'front-0123456789');
    const replaced = await request(app).get('/').set(REQUEST_ID_HEADER, 'a b <script>');
    expect(kept.headers['x-request-id']).toBe('front-0123456789');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('masks the ids of an unmatched path, writes 5xx at error and skips /health', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/nope/someone@example.com/42');
    await request(app).get('/boom');
    await request(app).get('/health');
    expect(lines.map((line) => [line.level, line.path, line.status])).toEqual([
      ['INFO', '/nope/{id}/{id}', 404],
      ['ERROR', '/boom', 503],
    ]);
  });

  it('writes an abandoned request at info', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/slow').timeout(50).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines).toEqual([expect.objectContaining({ level: 'INFO', message: 'request aborted', aborted: true, path: '/slow' })]);
  });

  it('uses the lib logger by default', async () => {
    const logs = captureLogs();
    const app = express();
    app.use(requestLogger());
    app.get('/', (_req, res) => res.send('ok'));
    await request(app).get('/');
    jest.restoreAllMocks();
    expect(logs).toEqual([expect.objectContaining({ target: 'bff', path: '/', status: 200 })]);
  });

  it('gives no id to a request that did not go through it', async () => {
    const app = express();
    app.get('/', (req, res) => res.json({ id: requestId(req) ?? null }));
    expect((await request(app).get('/')).body).toEqual({ id: null });
  });
});
