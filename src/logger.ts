import { randomUUID } from 'node:crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Request, RequestHandler } from 'express';
import { urlTemplate } from './telemetry';

/**
 * Structured logs of the BFFs (MAIR-531): one JSON object per line on stdout, the shape the APIs print with
 * `LOG_FORMAT=json` flattened (`timestamp`, `level`, `target`, `message`, then the fields).
 *
 * Fields are scalars only, so a header or body cannot be logged by passing the object: log an error through
 * `describeError(error)` (MAIR-290), never the error itself, and never an e-mail, a token or a request value.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A field value: scalars only. `undefined` fields are left out of the line. */
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger adding these fields to every line (`target` overrides the target). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** `target` of every line, usually the service name (`bff-user`). Default `bff`. */
  target?: string;
  /** Lowest level written. Default: `LOG_LEVEL`, read on every line, else `info`. */
  level?: LogLevel;
  /** Fields added to every line. */
  fields?: LogFields;
  /** Where a line goes (without its newline). Default: `process.stdout`. */
  write?: (line: string) => void;
  /** Clock of the `timestamp`. Default: `Date.now`. */
  now?: () => number;
}

/** Keys written by the logger itself: a field cannot replace them. */
const RESERVED = new Set(['timestamp', 'level', 'target', 'message']);

function levelOf(value: string | undefined): LogLevel {
  const level = value?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(level ?? '') ? (level as LogLevel) : 'info';
}

/** `trace_id` / `span_id` of the active span, so a log line can be matched to its trace (MAIR-504). */
function traceFields(): LogFields {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context) ? { trace_id: context.traceId, span_id: context.spanId } : {};
}

function scalar(value: LogValue): LogValue {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return typeof value === 'object' && value !== null ? '[object]' : value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const { target: childTarget, ...base } = options.fields ?? {};
  const target = typeof childTarget === 'string' && childTarget ? childTarget : (options.target ?? 'bff');

  const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
    const threshold = options.level ?? levelOf(process.env.LOG_LEVEL);
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(threshold)) return;
    const line: Record<string, LogValue> = {
      timestamp: new Date(now()).toISOString(),
      level: level.toUpperCase(),
      target,
      message,
    };
    for (const [key, value] of Object.entries({ ...traceFields(), ...base, ...fields })) {
      if (value !== undefined && !RESERVED.has(key)) line[key] = scalar(value);
    }
    try {
      write(JSON.stringify(line));
    } catch {
      // A log line must never break the request that wrote it.
    }
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (fields) => createLogger({ ...options, target, fields: { ...base, ...fields } }),
  };
}

/** The lib's default logger: target `bff`. A BFF builds its own with `createLogger({ target: 'bff-user' })`. */
export const logger: Logger = createLogger();

/** Header carrying the request id, read from the caller when well-formed and always answered. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** An incoming id is kept only when it cannot carry anything but an id. */
const REQUEST_ID = /^[\w.-]{8,128}$/;

const REQUEST_IDS = new WeakMap<Request, string>();

/** The id `requestLogger` gave this request, or `undefined` when it did not go through it. */
export function requestId(req: Request): string | undefined {
  return REQUEST_IDS.get(req);
}

/** The route that matched (`/admin/users/:userId`), else the path with its ids masked (`urlTemplate`). */
function routeOf(req: Request): string {
  const route = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof route === 'string') return `${req.baseUrl}${route}` || '/';
  return urlTemplate(req.originalUrl);
}

export interface RequestLoggerOptions {
  /** Logger of the request lines. Default: the lib's `logger`. */
  logger?: Logger;
  /** Paths not logged (exact match, query string ignored). Default `['/health']`: the probes would flood the logs. */
  ignorePaths?: readonly string[];
}

/**
 * Middleware giving each request an id (`X-Request-Id`, kept from the caller when well-formed) and writing one
 * line when it ends: `method`, `path` (the matched route, never the query string nor an id outside a route
 * parameter), `status`, `duration_ms`, `request_id`. 5xx are written at `error`, the rest at `info`; a request
 * the client abandoned is written at `warn` with `aborted: true`. Mount it first.
 */
export function requestLogger(options: RequestLoggerOptions = {}): RequestHandler {
  const log = options.logger ?? logger;
  const ignored = new Set(options.ignorePaths ?? ['/health']);
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    REQUEST_IDS.set(req, id);
    res.setHeader(REQUEST_ID_HEADER, id);
    if (ignored.has(req.path)) return next();

    const started = process.hrtime.bigint();
    let done = false;
    const end = (aborted: boolean) => {
      if (done) return;
      done = true;
      const fields = {
        request_id: id,
        method: req.method,
        path: routeOf(req),
        status: res.statusCode,
        duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
      };
      if (aborted) log.warn('request aborted', { ...fields, aborted: true });
      else if (res.statusCode >= 500) log.error('request completed', fields);
      else log.info('request completed', fields);
    };
    res.once('finish', () => end(false));
    // `close` without `finish`: the client went away before the answer was written.
    res.once('close', () => end(!res.writableFinished));
    next();
  };
}

