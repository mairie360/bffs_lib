import { createHash, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { verifiedSession } from './session';
import { urlTemplate } from './telemetry';

/**
 * Aggregated usage telemetry (MAIR-501): what is used, how much and by how many agents, never who does what.
 *
 * Counts per service, operation (route template), method, status and period: actions, distinct users and summed
 * latency. Distinct users are a set of `sha256(period salt, user id)`; the salt is drawn at random for each period,
 * kept in memory only and dropped with the hashes when the period closes, so no id, hash or salt is ever logged,
 * stored or exported. Only closed periods are served, and a count under the threshold `k` is not: small operations
 * are summed into one `other` entry, dropped too when it is under `k`.
 */

/** Default length of a period: one hour. */
export const DEFAULT_USAGE_PERIOD_MS = 3_600_000;
/** Default minimum count exported. */
export const DEFAULT_USAGE_THRESHOLD = 5;
/** Default number of closed periods kept for the collector (two days of hours). */
export const DEFAULT_USAGE_RETAINED_PERIODS = 48;
/** Path the instance's collector scrapes (never exposed by the ingress). */
export const USAGE_METRICS_PATH = '/internal/usage';

/** Usage of one operation in one closed period: counts only. */
export interface UsageEntry {
  service: string;
  operation: string;
  method: string;
  status: number;
  /** Start of the period, in seconds since the epoch. */
  periodStart: number;
  actions: number;
  distinctUsers: number;
  latencyMsSum: number;
}

export interface UsageLedgerOptions {
  service: string;
  periodMs?: number;
  threshold?: number;
  retainedPeriods?: number;
}

interface Counter {
  actions: number;
  latencyMsSum: number;
  users: Set<string>;
}

interface Period {
  index: number;
  salt: Buffer;
  counters: Map<string, Counter>;
}

export interface UsageLedger {
  readonly service: string;
  readonly threshold: number;
  /** Records one request; `userId` only lives as a salted hash until the period closes. */
  record(operation: string, method: string, status: number, latencyMs: number, userId: number | undefined, now?: number): void;
  /** The closed periods kept, oldest first, with the threshold applied. */
  closedEntries(now?: number): UsageEntry[];
  /** The closed periods in the Prometheus text format. */
  renderPrometheus(now?: number): string;
}

const SEPARATOR = '\u0000';

export function createUsageLedger(options: UsageLedgerOptions): UsageLedger {
  const service = options.service;
  const periodMs = options.periodMs && options.periodMs > 0 ? options.periodMs : DEFAULT_USAGE_PERIOD_MS;
  const threshold = Math.max(1, options.threshold ?? DEFAULT_USAGE_THRESHOLD);
  const retained = Math.max(1, options.retainedPeriods ?? DEFAULT_USAGE_RETAINED_PERIODS);
  const indexOf = (now: number): number => Math.floor(now / periodMs);
  const newPeriod = (index: number): Period => ({ index, salt: randomBytes(32), counters: new Map() });
  let current = newPeriod(indexOf(Date.now()));
  const closed: UsageEntry[][] = [];

  // Turns a period into counts; its salt and hashes go with it.
  const close = (period: Period): UsageEntry[] => {
    const periodStart = Math.floor((period.index * periodMs) / 1000);
    const entries: UsageEntry[] = [];
    const other: UsageEntry = { service, operation: 'other', method: 'other', status: 0, periodStart, actions: 0, distinctUsers: 0, latencyMsSum: 0 };
    const otherUsers = new Set<string>();
    for (const key of [...period.counters.keys()].sort()) {
      const counter = period.counters.get(key) as Counter;
      const [operation, method, status] = key.split(SEPARATOR);
      const distinct = counter.users.size;
      if (counter.actions < threshold || (distinct > 0 && distinct < threshold)) {
        other.actions += counter.actions;
        other.latencyMsSum += counter.latencyMsSum;
        counter.users.forEach((hash) => otherUsers.add(hash));
        continue;
      }
      entries.push({ service, operation, method, status: Number(status), periodStart, actions: counter.actions, distinctUsers: distinct, latencyMsSum: counter.latencyMsSum });
    }
    other.distinctUsers = otherUsers.size;
    if (other.actions >= threshold && (other.distinctUsers === 0 || other.distinctUsers >= threshold)) entries.push(other);
    return entries;
  };

  const roll = (now: number): void => {
    const index = indexOf(now);
    if (index === current.index) return;
    const entries = close(current);
    current = newPeriod(index);
    if (entries.length > 0) closed.push(entries);
    while (closed.length > retained) closed.shift();
  };

  const closedEntries = (now: number = Date.now()): UsageEntry[] => {
    roll(now);
    return closed.flat().map((entry) => ({ ...entry }));
  };

  const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const labels = (e: UsageEntry): string =>
    `service="${escape(e.service)}",operation="${escape(e.operation)}",method="${escape(e.method)}",status="${e.status}",period_start="${e.periodStart}"`;

  return {
    service,
    threshold,
    record(operation, method, status, latencyMs, userId, now = Date.now()) {
      roll(now);
      const key = [operation, method, String(status)].join(SEPARATOR);
      let counter = current.counters.get(key);
      if (counter === undefined) {
        counter = { actions: 0, latencyMsSum: 0, users: new Set() };
        current.counters.set(key, counter);
      }
      counter.actions += 1;
      counter.latencyMsSum += Math.max(0, Math.round(latencyMs));
      if (userId !== undefined) counter.users.add(createHash('sha256').update(current.salt).update(String(userId)).digest('hex'));
    },
    closedEntries,
    renderPrometheus(now = Date.now()) {
      const entries = closedEntries(now);
      const lines = [
        '# HELP mairie360_usage_actions Requests per operation and period (MAIR-501).',
        '# TYPE mairie360_usage_actions gauge',
        ...entries.map((e) => `mairie360_usage_actions{${labels(e)}} ${e.actions}`),
        '# HELP mairie360_usage_distinct_users Distinct users per operation and period, counted without identifiers.',
        '# TYPE mairie360_usage_distinct_users gauge',
        ...entries.map((e) => `mairie360_usage_distinct_users{${labels(e)}} ${e.distinctUsers}`),
        '# HELP mairie360_usage_latency_ms_sum Summed duration of the requests, in milliseconds.',
        '# TYPE mairie360_usage_latency_ms_sum gauge',
        ...entries.map((e) => `mairie360_usage_latency_ms_sum{${labels(e)}} ${e.latencyMsSum}`),
      ];
      return `${lines.join('\n')}\n`;
    },
  };
}

/** Route template of a finished request: the Express route (`/users/:id`), else the path with its values replaced. */
function operationOf(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === 'string') return `${req.baseUrl}${routePath}`;
  return urlTemplate(req.originalUrl ?? req.url);
}

/**
 * Records every request into `ledger` once its answer is sent: route template (never the path with its values or the
 * query), method, status, duration and the caller verified by `requireSession`, if any. Mount it first:
 * `app.use(usageMiddleware(ledger))`.
 */
export function usageMiddleware(ledger: UsageLedger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      ledger.record(operationOf(req), req.method, res.statusCode, latencyMs, verifiedSession(req)?.userId);
    });
    next();
  };
}

/** `GET /internal/usage`: the closed periods of `ledger` in the Prometheus text format. */
export function usageMetricsHandler(ledger: UsageLedger): RequestHandler {
  return (_req: Request, res: Response) => {
    res.type('text/plain; version=0.0.4').send(ledger.renderPrometheus());
  };
}
