import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { authorization } from './auth';
import { baseUrl } from './config';
import { describeError } from './describe-error';
import { HttpError } from './errors';
import { logger as defaultLogger, requestId, type Logger } from './logger';
import { parseRequest } from './validation';

/**
 * Global search of the header (every front): each BFF queries the business APIs' `GET /api/v1/search` itself, in
 * parallel, and merges their answers by module. No BFF calls another BFF.
 */

/** Modules of the answer, in display order, with the upstream service each one comes from. */
export const SEARCH_MODULES = ['agents', 'projects', 'calendar', 'messages', 'elearning'] as const;
export type SearchModule = (typeof SEARCH_MODULES)[number];

/** Upstream service of each module: its base URL comes from `<SERVICE>_URL` (`baseUrl`). */
export const SEARCH_SERVICES: Readonly<Record<SearchModule, string>> = {
  agents: 'CORE_API',
  projects: 'PROJECT_API',
  calendar: 'CALENDAR_API',
  messages: 'MESSAGE_API',
  elearning: 'ELEARNING_API',
};

/** Path of the search route on every business API. */
export const SEARCH_API_PATH = '/api/v1/search';
/** Most time given to each API, in ms: a slower API is listed in `unavailable`, the others are still shown. */
export const SEARCH_TIMEOUT_MS = 1_500;
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** `?q=&limit=` of `GET /search`, with the APIs' rules, so the BFF names the bad field before any upstream call. */
export const GlobalSearchQuerySchema = z.object({
  q: z
    .string({ error: 'Required' })
    .refine((value) => !CONTROL.test(value), { message: 'Must not contain control characters' })
    .transform((value) => value.trim())
    .refine((value) => [...value].length >= SEARCH_MIN_LENGTH, { message: `Must be at least ${SEARCH_MIN_LENGTH} characters` })
    .refine((value) => [...value].length <= SEARCH_MAX_LENGTH, { message: `Must be at most ${SEARCH_MAX_LENGTH} characters` }),
  limit: z.coerce
    .number({ error: `Must be an integer between 1 and ${SEARCH_MAX_LIMIT}` })
    .int({ error: `Must be an integer between 1 and ${SEARCH_MAX_LIMIT}` })
    .min(1, { error: `Must be an integer between 1 and ${SEARCH_MAX_LIMIT}` })
    .max(SEARCH_MAX_LIMIT, { error: `Must be an integer between 1 and ${SEARCH_MAX_LIMIT}` })
    .optional(),
});
export type GlobalSearchQuery = z.output<typeof GlobalSearchQuerySchema>;

export const SearchKindSchema = z.enum(['agent', 'project', 'task', 'event', 'conversation', 'message', 'course']);

/** One result, as every business API returns it. The front builds its link from the group's `module`, `kind` and `id`. */
export const SearchItemSchema = z.object({
  kind: SearchKindSchema,
  id: z.number().int(),
  title: z.string(),
  excerpt: z.string().nullable(),
  /** The project of a task; `null` otherwise. */
  parent_id: z.number().int().nullable(),
  updated_at: z.string(),
});
export type SearchItem = z.output<typeof SearchItemSchema>;

const ApiSearchResponseSchema = z.object({ items: z.array(SearchItemSchema) });

export const SearchModuleSchema = z.enum(SEARCH_MODULES);

/**
 * Answer of `GET /search`: one group per module with at least one result, in `SEARCH_MODULES` order, and the modules
 * that could not answer (failure, timeout, not configured). Register it in the BFF's OpenAPI registry.
 */
export const GlobalSearchResponseSchema = z.object({
  groups: z.array(z.object({ module: SearchModuleSchema, items: z.array(SearchItemSchema) })),
  unavailable: z.array(SearchModuleSchema),
});
export type GlobalSearchResponse = z.output<typeof GlobalSearchResponseSchema>;

export interface GlobalSearchOptions {
  /** Modules queried; every module by default. */
  modules?: readonly SearchModule[];
  /** Most time given to each API, in ms. Default: `SEARCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** `fetch` implementation (tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Logger of the unavailable modules. Default: the lib's `logger`. */
  logger?: Logger;
}

/** An API that answered 401: the session is refused (revoked, archived account), so the search is too. */
class SessionRefused extends Error {}

async function searchModule(
  module: SearchModule,
  query: GlobalSearchQuery,
  Authorization: string,
  options: GlobalSearchOptions,
): Promise<SearchItem[]> {
  const url = new URL(`${baseUrl(SEARCH_SERVICES[module])}${SEARCH_API_PATH}`);
  url.searchParams.set('q', query.q);
  url.searchParams.set('limit', String(query.limit ?? SEARCH_DEFAULT_LIMIT));
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Authorization, Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS),
  });
  if (response.status === 401) throw new SessionRefused();
  if (!response.ok) throw new HttpError(502, undefined, { cause: new Error(`${SEARCH_SERVICES[module]} answered ${response.status}`) });
  return ApiSearchResponseSchema.parse(await response.json()).items;
}

/**
 * Queries the business APIs in parallel with the caller's Bearer token (each API applies its own access rules) and
 * merges their results. An API that fails, times out, answers out of contract or is not configured is listed in
 * `unavailable`; a 401 from any of them is a 401. The search term is never logged.
 */
export async function globalSearch(
  req: Pick<Request, 'headers'>,
  query: GlobalSearchQuery,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResponse> {
  const Authorization = authorization(req);
  const modules = SEARCH_MODULES.filter((module) => (options.modules ?? SEARCH_MODULES).includes(module));
  const results = await Promise.allSettled(modules.map((module) => searchModule(module, query, Authorization, options)));
  if (results.some((result) => result.status === 'rejected' && result.reason instanceof SessionRefused)) {
    throw new HttpError(401);
  }
  const log = options.logger ?? defaultLogger;
  const answer: GlobalSearchResponse = { groups: [], unavailable: [] };
  results.forEach((result, index) => {
    const module = modules[index];
    if (result.status === 'fulfilled') {
      if (result.value.length > 0) answer.groups.push({ module, items: result.value });
      return;
    }
    answer.unavailable.push(module);
    log.warn('search upstream unavailable', {
      request_id: requestId(req as Request),
      upstream: SEARCH_SERVICES[module],
      error: describeError(result.reason, { stack: false }),
    });
  });
  return answer;
}

/**
 * `GET /search` handler: validates `q` and `limit` (400 naming the field), then answers `globalSearch` with
 * `Cache-Control: no-store`. Mount it after `requireSession`: `router.get('/search', requireSession, globalSearchHandler())`.
 */
export function globalSearchHandler(options: GlobalSearchOptions = {}): RequestHandler {
  return async (req, res) => {
    const query = parseRequest(GlobalSearchQuerySchema, req.query, 'query');
    const answer = await globalSearch(req, query, options);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(answer);
  };
}
