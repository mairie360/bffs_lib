import type { IncomingMessage } from 'node:http';
import { DiagConsoleLogger, DiagLogLevel, diag, type Attributes, type Link } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, createAllowListAttributesProcessor } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NodeTracerProvider, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * The only span and metric attributes exported (MAIR-504, MAIR-290, MAIR-501): method, status, parameterised
 * route, upstream host. Everything that can carry a person's data is left out: `url.full`, `url.path`,
 * `url.query`, `client.address`, `network.peer.*`, `user_agent.original`, headers.
 */
export const TELEMETRY_ATTRIBUTES: readonly string[] = [
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'error.type',
  'network.protocol.version',
  'url.scheme',
  'url.template',
  'server.address',
  'server.port',
  'express.name',
  'express.type',
  'user_agent.synthetic.type',
];

const ALLOWED = new Set(TELEMETRY_ATTRIBUTES);

/** Only these exception attributes are kept: `exception.message` and `exception.stacktrace` may hold request values. */
const EXCEPTION_ATTRIBUTES = new Set(['exception.type']);

/** Paths not traced by default: the Kubernetes probes would flood the traces. */
export const UNTRACED_PATHS: readonly string[] = ['/health'];

/** Longest wait for the last spans and metrics on SIGTERM / SIGINT, well under the Kubernetes grace period. */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TelemetryOptions {
  /** `service.name`, e.g. `bff-user`. `OTEL_SERVICE_NAME` overrides it. */
  serviceName: string;
  /** `service.version`, usually the `version` of the BFF's `package.json`. */
  serviceVersion?: string;
  /** Incoming paths not traced (exact match, query string ignored). Default `UNTRACED_PATHS`. */
  untracedPaths?: readonly string[];
  /** Flush the telemetry before exiting on SIGTERM / SIGINT. Default true. */
  handleSignals?: boolean;
}

export interface Telemetry {
  /** Exports what is pending and stops the providers. */
  shutdown(): Promise<void>;
}

function allowed(attributes: Attributes, keep: Set<string>): Attributes {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => keep.has(key)));
}

/**
 * Upstream path with every segment that could identify someone replaced by `{id}`: only lowercase words
 * (`api`, `users`, `force_change_password`) and API versions (`v1`) are kept, so ids, UUIDs, e-mails and
 * tokens never leave the BFF. `/api/v1/users/42/groups?x=1` -> `/api/v1/users/{id}/groups`.
 */
export function urlTemplate(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  return pathname
    .split('/')
    .map((segment) => (segment === '' || /^[a-z_-]{1,40}$/.test(segment) || /^v\d{1,2}$/.test(segment) ? segment : '{id}'))
    .join('/');
}

/** Path of the request: `url.path` on server spans, the path of `url.full` on client spans. */
function spanPath(attributes: Attributes): string | undefined {
  const path = attributes['url.path'];
  if (typeof path === 'string') return path;
  const full = attributes['url.full'];
  if (typeof full !== 'string') return undefined;
  try {
    return new URL(full).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Copy of a finished span holding only `TELEMETRY_ATTRIBUTES`, with `url.template` derived from the
 * upstream path of client spans, no status message, and only the type of recorded exceptions.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const attributes = allowed(span.attributes, ALLOWED);
  const path = spanPath(span.attributes);
  if (path !== undefined && attributes['http.route'] === undefined) attributes['url.template'] = urlTemplate(path);
  const links: Link[] = span.links.map((link) => ({ context: link.context }));
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links,
    events: span.events
      .filter((event) => event.name === 'exception')
      .map((event) => ({ name: event.name, time: event.time, attributes: allowed(event.attributes ?? {}, EXCEPTION_ATTRIBUTES) })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** Span exporter passing every span through `redactSpan` before the wrapped exporter. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.exporter.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }
}

/** Telemetry is on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED` is not `true`. */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) && env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== 'true';
}

function untraced(paths: readonly string[]): (request: IncomingMessage) => boolean {
  return (request) => paths.includes((request.url ?? '').split('?', 1)[0]);
}

/**
 * Starts OpenTelemetry for a BFF (MAIR-504): HTTP server and client spans (W3C `traceparent` propagated
 * to the upstream APIs), Express route handler spans, HTTP metrics, exported over OTLP (http/protobuf)
 * to `OTEL_EXPORTER_OTLP_ENDPOINT`, the collector of the instance. Returns `undefined` and does nothing
 * when telemetry is off (`telemetryEnabled`): tests and local runs export nothing.
 *
 * Express must not be loaded yet: call it from a module imported by the entry point before the app,
 * `import './telemetry'` right after `import 'dotenv/config'`. Only `TELEMETRY_ATTRIBUTES` are exported.
 * `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` (e.g. `deployment.environment.name=prod`) override
 * the resource.
 */
export function startTelemetry(options: TelemetryOptions): Telemetry | undefined {
  if (!telemetryEnabled()) return undefined;
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const resource = defaultResource()
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
      }),
    )
    .merge(detectResources({ detectors: [envDetector] }));

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter()))],
  });
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    views: [{ instrumentName: '*', attributesProcessors: [createAllowListAttributesProcessor([...TELEMETRY_ATTRIBUTES])] }],
  });

  registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: untraced(options.untracedPaths ?? UNTRACED_PATHS),
      }),
      // Middleware and router layers would add one span each per request: only the route handlers are traced.
      // The matched route still names the server span and labels the metrics.
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER] }),
    ],
  });

  const telemetry: Telemetry = {
    shutdown: async () => {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };

  if (options.handleSignals ?? true) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, TELEMETRY_SHUTDOWN_TIMEOUT_MS).unref());
        void Promise.race([telemetry.shutdown(), timeout]).finally(() => process.kill(process.pid, signal));
      });
    }
  }

  console.log(`Telemetry enabled for ${options.serviceName}`);
  return telemetry;
}
