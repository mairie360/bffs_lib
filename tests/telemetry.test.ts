import { SpanKind, SpanStatusCode, type SpanContext } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { emptyResource } from '@opentelemetry/resources';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-node';
import {
  RedactingSpanExporter,
  TELEMETRY_ATTRIBUTES,
  redactSpan,
  startTelemetry,
  telemetryEnabled,
  urlTemplate,
} from '../src';

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

  it('starts, flushes on SIGTERM then re-raises the signal', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const handlers = new Map<string, () => void>();
    jest.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.once);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    const telemetry = startTelemetry({ serviceName: 'bff-test', serviceVersion: '1.0.0' });
    expect(telemetry).toBeDefined();
    expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);

    handlers.get('SIGTERM')?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('leaves the signals alone with handleSignals: false', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const once = jest.spyOn(process, 'once');
    const telemetry = startTelemetry({ serviceName: 'bff-test', handleSignals: false, untracedPaths: [] });
    expect(once).not.toHaveBeenCalled();
    await expect(telemetry?.shutdown()).resolves.toBeUndefined();
  });
});
