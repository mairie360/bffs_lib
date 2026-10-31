import { context, trace, TraceFlags } from '@opentelemetry/api';
import express from 'express';
import request from 'supertest';
import { REQUEST_ID_HEADER, createLogger, errorHandler, logger, notFoundHandler, requestId, requestLogger } from '../src';
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

describe('createLogger formats (MAIR-555)', () => {
  const NOW = () => Date.UTC(2026, 9, 13, 8, 30);
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  afterEach(() => {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  function textLogger(options: Parameters<typeof createLogger>[0] = {}) {
    const lines: string[] = [];
    const log = createLogger({ now: NOW, target: 'bff-user', format: 'text', colors: false, write: (line) => lines.push(line), ...options });
    return { log, lines };
  }

  /** Raw lines written on stdout, with stdout seen as a terminal or not. */
  function stdoutLines(isTTY: boolean): string[] {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    const lines: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      return true;
    }) as typeof process.stdout.write);
    return lines;
  }

  it('writes text lines like the APIs: timestamp, padded level, target, message, then key=value', () => {
    const { log, lines } = textLogger();
    log.info('request completed', { request_id: 'abc', status: 200, cached: false, none: null, missing: undefined });
    log.warn('slow', { path: '/a b', empty: '', quote: 'say "hi"', eq: 'a=b' });
    expect(lines).toEqual([
      '2026-10-13T08:30:00.000Z  INFO bff-user: request completed request_id=abc status=200 cached=false none=null',
      '2026-10-13T08:30:00.000Z  WARN bff-user: slow path="/a b" empty="" quote="say \\"hi\\"" eq="a=b"',
    ]);
  });

  it('keeps a text line on one line whatever the message or the fields hold', () => {
    const { log, lines } = textLogger();
    log.error('forged\n2026-01-01T00:00:00.000Z  INFO bff-user: fake', { value: 'a\nb\u001b[31m' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).not.toContain('\u001b');
    expect(lines[0]).toBe(
      '2026-10-13T08:30:00.000Z ERROR bff-user: forged\\n2026-01-01T00:00:00.000Z  INFO bff-user: fake value="a\\nb\\u001b[31m"',
    );
  });

  it('colours the level, dims the timestamp and target, italicises the keys', () => {
    const { log, lines } = textLogger({ colors: true });
    log.error('failed', { status: 502 });
    log.debug('hidden');
    process.env.LOG_LEVEL = 'debug';
    log.debug('shown');
    expect(lines).toEqual([
      '\u001b[2m2026-10-13T08:30:00.000Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mbff-user:\u001b[0m failed \u001b[3mstatus\u001b[0m=502',
      '\u001b[2m2026-10-13T08:30:00.000Z\u001b[0m \u001b[34mDEBUG\u001b[0m \u001b[2mbff-user:\u001b[0m shown',
    ]);
  });

  it('writes coloured text on a terminal outside the tests', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOG_FORMAT;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    const lines = stdoutLines(true);
    createLogger({ now: NOW, target: 'bff-user' }).info('hello', { status: 1 });
    jest.restoreAllMocks();
    expect(lines).toEqual(['\u001b[2m2026-10-13T08:30:00.000Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[2mbff-user:\u001b[0m hello \u001b[3mstatus\u001b[0m=1']);
  });

  it('keeps JSON in containers, in the tests, for a custom writer and with LOG_FORMAT=json', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_FORMAT;
    const piped = stdoutLines(false);
    createLogger({ now: NOW }).info('container');
    process.env.NODE_ENV = 'test';
    const tests = stdoutLines(true);
    createLogger({ now: NOW }).info('tests');
    process.env.NODE_ENV = 'production';
    process.env.LOG_FORMAT = ' JSON ';
    const forced = stdoutLines(true);
    createLogger({ now: NOW }).info('forced');
    jest.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    const custom: string[] = [];
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    createLogger({ now: NOW, write: (line) => custom.push(line) }).info('custom');
    for (const [lines, message] of [[piped, 'container'], [tests, 'tests'], [forced, 'forced'], [custom, 'custom']] as const) {
      expect(lines.map((line) => JSON.parse(line))).toEqual([{ timestamp: '2026-10-13T08:30:00.000Z', level: 'INFO', target: 'bff', message }]);
    }
  });

  it('reads LOG_FORMAT on every line and ignores an unknown value', () => {
    const lines: string[] = [];
    const log = createLogger({ now: NOW, colors: false, write: (line) => lines.push(line) });
    process.env.LOG_FORMAT = 'Text';
    log.info('a');
    process.env.LOG_FORMAT = 'yaml';
    log.info('b');
    expect(lines[0]).toBe('2026-10-13T08:30:00.000Z  INFO bff: a');
    expect(JSON.parse(lines[1])).toEqual(expect.objectContaining({ message: 'b' }));
  });

  it('follows FORCE_COLOR then NO_COLOR, else colours on a terminal only', () => {
    process.env.LOG_FORMAT = 'text';
    const colored = (line: string) => line.includes('\u001b[');
    const run = (isTTY: boolean, env: Record<string, string | undefined>) => {
      delete process.env.FORCE_COLOR;
      delete process.env.NO_COLOR;
      Object.assign(process.env, env);
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
      const lines = stdoutLines(isTTY);
      createLogger({ now: NOW }).info('x');
      jest.restoreAllMocks();
      return colored(lines[0]);
    };
    expect(run(true, {})).toBe(true);
    expect(run(false, {})).toBe(false);
    expect(run(true, { NO_COLOR: '1' })).toBe(false);
    expect(run(false, { FORCE_COLOR: '1' })).toBe(true);
    expect(run(true, { FORCE_COLOR: '1', NO_COLOR: '1' })).toBe(true);
    expect(run(true, { FORCE_COLOR: '0' })).toBe(false);
    expect(run(true, { FORCE_COLOR: 'false' })).toBe(false);
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
    users.get('/:userId/fail', (_req, _res, next) => next(new Error('boom')));
    users.get(['/:userId/a', '/:userId/b'], (_req, _res, next) => next(new Error('boom')));
    users.get('/:userId/files/*file', (_req, _res, next) => next(new Error('boom')));
    // A rewritten URL: req.originalUrl keeps the requested one, shorter than the route that matches.
    app.use((req, _res, next) => {
      if (req.url === '/legacy') req.url = '/users/42/fail';
      next();
    });
    app.use('/users', users);
    const projects = express.Router({ mergeParams: true });
    projects.get('/:taskId', (_req, _res, next) => next(new Error('boom')));
    app.use('/projects/:projectId/tasks', projects);
    app.get('/health', (_req, res) => res.send('OK'));
    app.get('/boom', (_req, res) => res.status(503).end());
    app.get('/', (_req, res) => res.send('root'));
    app.get(['/openapi.json', '/swagger.json'], (_req, res) => res.json({}));
    app.get('/slow', (_req, res) => {
      setTimeout(() => res.end(), 200);
    });
    app.use(notFoundHandler);
    app.use(errorHandler({ logger: createLogger({ write: () => undefined }) }));
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
    // Neither the id nor the query string: only the route is written (request_id is random, it may hold "42").
    expect(Object.values(lines[0]).filter((value) => value !== lines[0].request_id).join(' ')).not.toMatch(/\b42\b|example/);
  });

  it('writes the requested path of a route declared with several paths', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/swagger.json');
    expect(lines[0]).toEqual(expect.objectContaining({ path: '/swagger.json', status: 200 }));
  });

  // MAIR-531: Express resets req.baseUrl while an error leaves a mounted router, so the route lost its mount path.
  it('writes the full route of a mounted route that failed, with no id of its mount path', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/users/42/fail');
    await request(app).get('/users/42/b');
    await request(app).get('/projects/7/tasks/9');
    expect(lines.map((line) => [line.path, line.status])).toEqual([
      ['/users/:userId/fail', 500],
      ['/users/:userId/b', 500],
      ['/projects/{id}/tasks/:taskId', 500],
    ]);
  });

  it('writes the masked path when the route cannot be laid on the requested URL', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/users/42/files/report.pdf');
    await request(app).get('/legacy');
    expect(lines.map((line) => [line.path, line.status])).toEqual([
      ['/users/{id}/files/{id}', 500],
      ['/legacy', 500],
    ]);
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
