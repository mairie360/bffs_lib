import type { IncomingMessage } from 'node:http';
import { DiagLogLevel, context, diag, propagation, trace, type Attributes, type DiagLogger, type Link } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
  getNumberFromEnv,
  getStringFromEnv,
  type ExportResult,
} from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, createAllowListAttributesProcessor } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type BatchSpanProcessorOptions,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { maskValues } from './describe-error';
import { logger } from './logger';

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

/** Longest wait for the last spans and metrics on shutdown, well under the Kubernetes grace period. */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TelemetryOptions {
  /** `service.name`, e.g. `bff-user`. `OTEL_SERVICE_NAME` overrides it. */
  serviceName: string;
  /** `service.version`, usually the `version` of the BFF's `package.json`. */
  serviceVersion?: string;
  /** Incoming paths not traced (exact match, query string ignored). Default `UNTRACED_PATHS`. */
  untracedPaths?: readonly string[];
  /**
   * @deprecated Ignored: the signals are handled by `gracefulShutdown`, which drains the server and then flushes the
   * telemetry `startTelemetry` started.
   */
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
/**
 * The OpenTelemetry diagnostics (export failures) as JSON lines of the lib's logger (MAIR-531): the message only,
 * masked, never the arguments (an exporter error can carry the request it failed to send).
 */
export const diagLogger: DiagLogger = {
  error: (message) => logger.error(maskValues(message), { source: 'opentelemetry' }),
  warn: (message) => logger.warn(maskValues(message), { source: 'opentelemetry' }),
  info: (message) => logger.info(maskValues(message), { source: 'opentelemetry' }),
  debug: (message) => logger.debug(maskValues(message), { source: 'opentelemetry' }),
  verbose: (message) => logger.debug(maskValues(message), { source: 'opentelemetry' }),
};

/**
 * The sampler of the standard `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` variables, which the OpenTelemetry 3
 * `TracerProvider` no longer reads (the 2.x `NodeTracerProvider` did). Unset or unknown: `parentbased_always_on`,
 * the SDK default.
 */
export function samplerFromEnv(): Sampler {
  const ratio = (): number => {
    const value = getNumberFromEnv('OTEL_TRACES_SAMPLER_ARG');
    return value === undefined || value < 0 || value > 1 ? 1 : value;
  };
  switch (getStringFromEnv('OTEL_TRACES_SAMPLER')) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio());
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio()) });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

/** The batch options of the standard `OTEL_BSP_*` variables, also no longer read by OpenTelemetry 3; unset ones keep the SDK defaults. */
export function batchOptionsFromEnv(exporter: SpanExporter): BatchSpanProcessorOptions {
  const options: BatchSpanProcessorOptions = { exporter };
  const read = (name: string): number | undefined => {
    const value = getNumberFromEnv(name);
    return value !== undefined && value > 0 ? value : undefined;
  };
  const maxQueueSize = read('OTEL_BSP_MAX_QUEUE_SIZE');
  const maxExportBatchSize = read('OTEL_BSP_MAX_EXPORT_BATCH_SIZE');
  const scheduledDelayMillis = read('OTEL_BSP_SCHEDULE_DELAY');
  const exportTimeoutMillis = read('OTEL_BSP_EXPORT_TIMEOUT');
  if (maxQueueSize !== undefined) options.maxQueueSize = maxQueueSize;
  if (maxExportBatchSize !== undefined) options.maxExportBatchSize = maxExportBatchSize;
  if (scheduledDelayMillis !== undefined) options.scheduledDelayMillis = scheduledDelayMillis;
  if (exportTimeoutMillis !== undefined) options.exportTimeoutMillis = exportTimeoutMillis;
  return options;
}

let current: Telemetry | undefined;

/** The telemetry `startTelemetry` started in this process, flushed by `gracefulShutdown`. */
export function activeTelemetry(): Telemetry | undefined {
  return current;
}

export function startTelemetry(options: TelemetryOptions): Telemetry | undefined {
  if (!telemetryEnabled()) return undefined;
  diag.setLogger(diagLogger, DiagLogLevel.ERROR);

  const resource = defaultResource()
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
      }),
    )
    .merge(detectResources({ detectors: [envDetector] }));

  const tracerProvider = new TracerProvider({
    resource,
    sampler: samplerFromEnv(),
    spanProcessors: [new BatchSpanProcessor(batchOptionsFromEnv(new RedactingSpanExporter(new OTLPTraceExporter())))],
  });
  // What NodeTracerProvider.register() did before OpenTelemetry 3: async context, W3C propagation, global provider.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
  trace.setGlobalTracerProvider(tracerProvider);

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

  current = telemetry;

  logger.info('telemetry enabled', { service: options.serviceName });
  return telemetry;
}
