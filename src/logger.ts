import { randomUUID } from 'node:crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Request, RequestHandler } from 'express';
import { urlTemplate } from './telemetry';

/**
 * Structured logs of the BFFs (MAIR-531): one JSON object per line on stdout, the shape the APIs print with
 * `LOG_FORMAT=json` flattened (`timestamp`, `level`, `target`, `message`, then the fields). On a terminal, the
 * lines are human-readable and coloured instead, like the APIs' default format (MAIR-555): see `LogFormat`.
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

/**
 * `json`: one JSON object per line. `text`: `timestamp LEVEL target: message key=value…`, the APIs' default format.
 * Default: `LOG_FORMAT`, read on every line, else `text` when the lines go to a terminal outside the tests
 * (`NODE_ENV=test`), else `json` (containers, log collectors).
 */
export const LOG_FORMATS = ['json', 'text'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export interface LoggerOptions {
  /** `target` of every line, usually the service name (`bff-user`). Default `bff`. */
  target?: string;
  /** Lowest level written. Default: `LOG_LEVEL`, read on every line, else `info`. */
  level?: LogLevel;
  /** Fields added to every line. */
  fields?: LogFields;
  /** Line format. Default: see `LogFormat`. */
  format?: LogFormat;
  /**
   * ANSI colours of the `text` format. Default: `FORCE_COLOR` set (and not `0` / `false`) colours, else `NO_COLOR`
   * set does not, else colours when the lines go to a terminal. Never applied to `json`.
   */
  colors?: boolean;
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

/** Whether the default writer goes to a terminal. */
function stdoutIsTty(): boolean {
  return process.stdout.isTTY === true;
}

function formatOf(value: string | undefined, toTerminal: boolean): LogFormat {
  const format = value?.trim().toLowerCase();
  if ((LOG_FORMATS as readonly string[]).includes(format ?? '')) return format as LogFormat;
  return toTerminal && process.env.NODE_ENV !== 'test' ? 'text' : 'json';
}

function colorsOf(toTerminal: boolean): boolean {
  const force = process.env.FORCE_COLOR?.trim().toLowerCase();
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false';
  if (process.env.NO_COLOR) return false;
  return toTerminal;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const LEVEL_COLORS: Readonly<Record<LogLevel, string>> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

/** A text value on one line: quoted (JSON escapes) when empty or holding a space, `=`, a quote or a control character. */
function textValue(value: LogValue): string {
  const text = String(value);
  return text === '' || /[\s="\\\p{Cc}]/u.test(text) ? JSON.stringify(text) : text;
}

/** The message on one line: control characters escaped, so a value inside it cannot forge another line. */
function textMessage(message: string): string {
  return /\p{Cc}/u.test(message) ? JSON.stringify(message).slice(1, -1) : message;
}

/** `2026-10-13T08:30:00.000Z  INFO bff-user: request completed status=200`, coloured like `tracing`. */
function textLine(line: Record<string, LogValue>, level: LogLevel, colors: boolean): string {
  const paint = (style: string, text: string) => (colors ? `${style}${text}${RESET}` : text);
  const parts = [
    paint(DIM, String(line.timestamp)),
    paint(LEVEL_COLORS[level], level.toUpperCase().padStart(5)),
    `${paint(DIM, `${String(line.target)}:`)} ${textMessage(String(line.message))}`,
  ];
  for (const [key, value] of Object.entries(line)) if (!RESERVED.has(key)) parts.push(`${paint(ITALIC, key)}=${textValue(value)}`);
  return parts.join(' ');
}

function scalar(value: LogValue): LogValue {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return typeof value === 'object' && value !== null ? '[object]' : value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  // Only the default writer can reach a terminal: a custom one gets JSON unless asked otherwise.
  const toTerminal = () => options.write === undefined && stdoutIsTty();
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
      const format = options.format ?? formatOf(process.env.LOG_FORMAT, toTerminal());
      write(format === 'text' ? textLine(line, level, options.colors ?? colorsOf(toTerminal())) : JSON.stringify(line));
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

const REQUEST_IDS = new WeakMap<object, string>();

/**
 * The id `requestLogger` gave this request, or `undefined` when it did not go through it. Takes any view of the
 * request object (`Pick<Request, 'headers'>` of an upstream caller included).
 */
export function requestId(req: object): string | undefined {
  return REQUEST_IDS.get(req);
}

/** Non-empty segments of a path. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Whether `route` (literal segments and `:params` only) matches the last segments of `requested`. */
function matchesTail(route: string, requested: string[]): boolean {
  if (/[*?{}()]/.test(route)) return false;
  const parts = segmentsOf(route);
  if (parts.length > requested.length) return false;
  const tail = requested.slice(requested.length - parts.length);
  return parts.every((part, i) => part.startsWith(':') || part.toLowerCase() === tail[i].toLowerCase());
}

/**
 * The route that matched (`/admin/users/:userId`; for a route declared with several paths, the one requested),
 * else the path with its ids masked (`urlTemplate`). The mount path is read from the requested URL, not
 * `req.baseUrl`: Express resets it when an error leaves a mounted router, before the response is written.
 */
function routeOf(req: Request): string {
  const pathname = req.originalUrl.split(/[?#]/, 1)[0];
  const requested = segmentsOf(pathname);
  const declared = (req.route as { path?: unknown } | undefined)?.path;
  const candidates: unknown[] = Array.isArray(declared) ? declared : [declared];
  const route = candidates.find((path): path is string => typeof path === 'string' && matchesTail(path, requested));
  if (route === undefined) return urlTemplate(pathname);
  const mount = urlTemplate(`/${requested.slice(0, requested.length - segmentsOf(route).length).join('/')}`);
  return `${mount === '/' ? '' : mount}${route}`;
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
 * the client abandoned (an SSE stream the client closed included) is written at `info` with `aborted: true`. Mount it first.
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
      if (aborted) log.info('request aborted', { ...fields, aborted: true });
      else if (res.statusCode >= 500) log.error('request completed', fields);
      else log.info('request completed', fields);
    };
    res.once('finish', () => end(false));
    // `close` without `finish`: the client went away before the answer was written.
    res.once('close', () => end(!res.writableFinished));
    next();
  };
}

