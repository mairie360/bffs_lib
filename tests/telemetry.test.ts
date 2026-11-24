import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context as otelContext, propagation, trace, type SpanContext } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { emptyResource } from '@opentelemetry/resources';
import { InMemorySpanExporter, SamplingDecision, type ReadableSpan } from '@opentelemetry/sdk-trace';
import {
  RedactingSpanExporter,
  TELEMETRY_ATTRIBUTES,
  diagLogger,
  redactSpan,
  startTelemetry,
  activeTelemetry,
  telemetryEnabled,
  urlTemplate,
} from '../src';
import { batchOptionsFromEnv, samplerFromEnv } from '../src/telemetry';
import { captureLogs } from './support/capture-logs';

const ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const context: SpanContext = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 1 };

function span(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: 'GET',
    kind: SpanKind.CLIENT,
    spanContext: () => context,
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: SpanStatusCode.ERROR, message: 'User marker@example.org not found' },
    attributes: {
      'http.request.method': 'GET',
      'http.response.status_code': 404,
      'server.address': 'core-api',
      'server.port': 8080,
      'url.full': 'http://core-api:8080/api/v1/users/42/groups?email=marker%40example.org',
      'user_agent.original': 'MarkerAgent',
      'client.address': '10.0.0.7',
    },
    links: [{ context, attributes: { 'user.id': 42 } }],
    events: [
      { name: 'exception', time: [1, 5], attributes: { 'exception.type': 'HttpError', 'exception.message': 'marker@example.org' } },
      { name: 'log', time: [1, 6], attributes: { email: 'marker@example.org' } },
    ],
    duration: [1, 0],
    ended: true,
    resource: emptyResource(),
    instrumentationScope: { name: 'test' },
    droppedAttributesCount: 3,
    droppedEventsCount: 1,
    droppedLinksCount: 0,
    ...overrides,
  };
}

describe('urlTemplate', () => {
  it('keeps lowercase words and API versions and replaces everything else', () => {
    expect(urlTemplate('/api/v1/users/42/groups?email=a@b.fr')).toBe('/api/v1/users/{id}/groups');
    expect(urlTemplate('/api/v1/auth/force_change_password')).toBe('/api/v1/auth/force_change_password');
    expect(urlTemplate('/files/3f2b8c1e-7a4d-4c55-9a7e-0c5f1d2e3b4a/marker@example.org#x')).toBe('/files/{id}/{id}');
    expect(urlTemplate('/users/Dupont/')).toBe('/users/{id}/');
  });
});

describe('redactSpan', () => {
  it('keeps only the allowed attributes and derives url.template from url.full on client spans', () => {
    const redacted = redactSpan(span());
    expect(redacted.attributes).toEqual({
      'http.request.method': 'GET',
      'http.response.status_code': 404,
      'server.address': 'core-api',
      'server.port': 8080,
      'url.template': '/api/v1/users/{id}/groups',
    });
    expect(Object.keys(redacted.attributes).every((key) => TELEMETRY_ATTRIBUTES.includes(key))).toBe(true);
    expect(redacted.spanContext()).toBe(context);
    expect(redacted.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(redacted.links).toEqual([{ context }]);
    expect(redacted.events).toEqual([{ name: 'exception', time: [1, 5], attributes: { 'exception.type': 'HttpError' } }]);
    expect(JSON.stringify(redacted)).not.toMatch(/marker|42|MarkerAgent|10\.0\.0\.7/i);
  });

  it('uses url.path on server spans, and keeps http.route instead when the route matched', () => {
    const server = { 'http.request.method': 'GET', 'url.path': '/user/42', 'url.query': 'email=x' };
    expect(redactSpan(span({ kind: SpanKind.SERVER, attributes: server })).attributes).toEqual({
      'http.request.method': 'GET',
      'url.template': '/user/{id}',
    });
    expect(redactSpan(span({ attributes: { ...server, 'http.route': '/user/:userId' } })).attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/user/:userId',
    });
  });

  it('adds no url.template without a usable URL, and tolerates events without attributes', () => {
    const redacted = redactSpan(span({ attributes: { 'url.full': 'not a url' }, events: [{ name: 'exception', time: [1, 0] }] }));
    expect(redacted.attributes).toEqual({});
    expect(redacted.events).toEqual([{ name: 'exception', time: [1, 0], attributes: {} }]);
    expect(redactSpan(span({ attributes: {} })).attributes).toEqual({});
  });
});

describe('RedactingSpanExporter', () => {
  it('exports redacted spans through the wrapped exporter', async () => {
    const inner = new InMemorySpanExporter();
    const exporter = new RedactingSpanExporter(inner);
    const result = await new Promise((resolve) => exporter.export([span()], resolve));
    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    expect(inner.getFinishedSpans()[0].attributes['url.full']).toBeUndefined();
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it('resolves forceFlush when the wrapped exporter has none', async () => {
    const exporter = new RedactingSpanExporter({ export: jest.fn(), shutdown: () => Promise.resolve() });
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });
});

describe('telemetryEnabled', () => {
  it('needs OTEL_EXPORTER_OTLP_ENDPOINT and honours OTEL_SDK_DISABLED', () => {
    expect(telemetryEnabled({})).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: ' ' })).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'TRUE' })).toBe(false);
  });
});

describe('startTelemetry', () => {
  it('does nothing without a collector endpoint', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(startTelemetry({ serviceName: 'bff-test' })).toBeUndefined();
  });

  it('MAIR-682 starts without handling the signals, and is the active telemetry', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    captureLogs();
    const once = jest.spyOn(process, 'once');
    const kill = jest.spyOn(process, 'kill');
    const telemetry = startTelemetry({ serviceName: 'bff-test', serviceVersion: '1.0.0', untracedPaths: [] });
    expect(telemetry).toBeDefined();
    expect(activeTelemetry()).toBe(telemetry);
    // The signals belong to gracefulShutdown, which drains the server first; re-raising SIGTERM killed requests.
    expect(once).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    await expect(telemetry?.shutdown()).resolves.toBeUndefined();
  });

  it('OpenTelemetry 3 keeps the async context and the W3C propagation that NodeTracerProvider.register() set up', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    captureLogs();
    const telemetry = startTelemetry({ serviceName: 'bff-test', untracedPaths: [] });
    const span = trace.getTracer('bff-test').startSpan('parent');
    const carrier: Record<string, string> = {};
    // The active span survives an await: without the AsyncLocalStorage manager, the upstream calls lose their parent.
    await otelContext.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
      await Promise.resolve();
      expect(trace.getActiveSpan()).toBe(span);
      propagation.inject(otelContext.active(), carrier);
    });
    // The upstream APIs receive the trace: without the W3C propagator, no traceparent header is sent.
    expect(carrier.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    span.end();
    await telemetry?.shutdown();
  });
});

describe('diagLogger', () => {
  it('writes the OpenTelemetry diagnostics as masked JSON lines, without their arguments', () => {
    process.env.LOG_LEVEL = 'debug';
    const logs = captureLogs();
    const header = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2ln';
    diagLogger.error(`export failed for ${header}`, { headers: { authorization: header } });
    diagLogger.warn('warn');
    diagLogger.info('info');
    diagLogger.debug('debug');
    diagLogger.verbose('verbose');
    jest.restoreAllMocks();
    expect(logs.map((line) => [line.level, line.message, line.source])).toEqual([
      ['ERROR', 'export failed for Bearer …', 'opentelemetry'],
      ['WARN', 'warn', 'opentelemetry'],
      ['INFO', 'info', 'opentelemetry'],
      ['DEBUG', 'debug', 'opentelemetry'],
      ['DEBUG', 'verbose', 'opentelemetry'],
    ]);
  });
});

describe('OpenTelemetry 3 sampling and batch variables', () => {
  const SAMPLER_VARIABLES = [
    'OTEL_TRACES_SAMPLER',
    'OTEL_TRACES_SAMPLER_ARG',
    'OTEL_BSP_MAX_QUEUE_SIZE',
    'OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
    'OTEL_BSP_SCHEDULE_DELAY',
    'OTEL_BSP_EXPORT_TIMEOUT',
  ];
  afterEach(() => {
    for (const name of SAMPLER_VARIABLES) delete process.env[name];
  });
  const decision = (traceId = '0af7651916cd43dd8448eb211c80319c') =>
    samplerFromEnv().shouldSample(ROOT_CONTEXT, traceId, 'span', SpanKind.SERVER, {}, []).decision;

  it('keeps the SDK default (parent based, always on) without OTEL_TRACES_SAMPLER', () => {
    expect(samplerFromEnv().toString()).toMatch(/ParentBased.*AlwaysOn/);
    expect(decision()).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it.each([
    ['always_off', undefined, SamplingDecision.NOT_RECORD],
    ['parentbased_always_off', undefined, SamplingDecision.NOT_RECORD],
    ['always_on', undefined, SamplingDecision.RECORD_AND_SAMPLED],
    ['traceidratio', '0', SamplingDecision.NOT_RECORD],
    ['parentbased_traceidratio', '0', SamplingDecision.NOT_RECORD],
    ['traceidratio', 'not a number', SamplingDecision.RECORD_AND_SAMPLED],
  ])('honours OTEL_TRACES_SAMPLER=%s (arg %s) as the 2.x SDK did', (sampler, arg, expected) => {
    process.env.OTEL_TRACES_SAMPLER = sampler;
    if (arg !== undefined) process.env.OTEL_TRACES_SAMPLER_ARG = arg;
    expect(decision()).toBe(expected);
  });

  it('passes the OTEL_BSP_* settings to the batch processor and keeps the defaults otherwise', () => {
    const exporter = new InMemorySpanExporter();
    expect(batchOptionsFromEnv(exporter)).toEqual({ exporter });
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = '8192';
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '1024';
    process.env.OTEL_BSP_SCHEDULE_DELAY = '1000';
    process.env.OTEL_BSP_EXPORT_TIMEOUT = '10000';
    expect(batchOptionsFromEnv(exporter)).toEqual({
      exporter,
      maxQueueSize: 8192,
      maxExportBatchSize: 1024,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: 10000,
    });
  });

  it('does not record spans when startTelemetry runs with OTEL_TRACES_SAMPLER=always_off', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    captureLogs();
    // The API keeps the first global provider: drop the one an earlier test registered.
    trace.disable();
    const telemetry = startTelemetry({ serviceName: 'bff-test', untracedPaths: [] });
    const span = trace.getTracer('bff-test').startSpan('dropped');
    expect(span.isRecording()).toBe(false);
    span.end();
    await telemetry?.shutdown();
  });
});
