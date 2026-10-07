/**
 * A loggable description of an error (MAIR-290): its type and context, never the values it carries.
 *
 * Logging an error as is prints all of it. An `HttpError` 502 keeps the failed axios call as `cause`, whose
 * `config.headers` hold the caller's Bearer token, `config.data` the request body (e-mail, password, phone)
 * and `response.data` the upstream's answer. This keeps, for each error of the `cause` chain: its name,
 * status, code, the method and path of an upstream call (query string dropped) and a message whose quoted
 * values, e-mails, tokens and long numbers are masked; then the stack frames of the first error.
 */

const MAX_CAUSES = 5;
const MAX_FRAMES = 10;

const MASKS: readonly [RegExp, string][] = [
  [/Bearer\s+\S+/gi, 'Bearer …'],
  [/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, '<jwt>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/"(?:[^"\\]|\\.)*"/g, '"…"'],
  [/'(?:[^'\\]|\\.)*'/g, "'…'"],
  [/`[^`]*`/g, '`…`'],
  [/\+?\d[\d ]{5,}\d/g, '<number>'],
];

/** `text` with the values a message may quote masked: quoted strings, e-mails, Bearer and JWT tokens, numbers of 7+ digits. */
export function maskValues(text: string): string {
  return MASKS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

type Shape = {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  isAxiosError?: unknown;
  config?: { method?: unknown; url?: unknown };
  response?: { status?: unknown };
  cause?: unknown;
  stack?: unknown;
};

const asShape = (error: unknown): Shape => (typeof error === 'object' && error !== null ? (error as Shape) : {});

/** The path of an upstream URL: no scheme, host or query string. */
function pathOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  return withoutQuery.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '') || '/';
}

function describeOne(error: unknown): string {
  if (typeof error === 'string') return maskValues(error);
  if (typeof error !== 'object' || error === null) return `${typeof error} thrown`;
  const shape = asShape(error);
  const parts: string[] = [typeof shape.name === 'string' && shape.name ? shape.name : 'Error'];
  const status = typeof shape.status === 'number' ? shape.status : shape.response?.status;
  if (typeof status === 'number') parts.push(String(status));
  if (typeof shape.code === 'string' || typeof shape.code === 'number') parts.push(String(shape.code));
  if (shape.isAxiosError === true && shape.config) {
    const method = typeof shape.config.method === 'string' ? shape.config.method.toUpperCase() : '?';
    const url = typeof shape.config.url === 'string' ? pathOf(shape.config.url) : '?';
    parts.push(`${method} ${maskValues(url)}`);
  }
  const message = typeof shape.message === 'string' ? maskValues(shape.message) : '';
  return message ? `${parts.join(' ')}: ${message}` : parts.join(' ');
}

/** The `at …` lines of a stack: file positions, no message. */
function framesOf(error: unknown): string[] {
  const stack = asShape(error).stack;
  if (typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => `    ${line.trim()}`);
}

export interface DescribeErrorOptions {
  /** Append the stack frames of the first error. Default `true`. */
  stack?: boolean;
}

/**
 * One line per error of the `cause` chain, then the stack frames of the first one:
 * `HttpError 502 BAD_GATEWAY: The CORE_API service is unavailable.` /
 * `  caused by AxiosError ECONNREFUSED POST /api/v1/auth/login: connect ECONNREFUSED …`.
 */
export function describeError(error: unknown, options: DescribeErrorOptions = {}): string {
  const lines = [describeOne(error)];
  const seen = new Set<unknown>([error]);
  let cause = asShape(error).cause;
  for (let depth = 0; cause !== undefined && cause !== null && !seen.has(cause) && depth < MAX_CAUSES; depth += 1) {
    lines.push(`  caused by ${describeOne(cause)}`);
    seen.add(cause);
    cause = asShape(cause).cause;
  }
  return [...lines, ...(options.stack === false ? [] : framesOf(error))].join('\n');
}
