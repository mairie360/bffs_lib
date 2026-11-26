import express from 'express';
import request from 'supertest';
import {
  ErrorResponseSchema,
  GlobalSearchResponseSchema,
  SEARCH_SERVICES,
  errorHandler,
  globalSearch,
  globalSearchHandler,
  type GlobalSearchOptions,
  type SearchItem,
  type SearchModule,
} from '../src';
import { captureLogs } from './support/capture-logs';

const TOKEN = 'header.payload.signature';
const HOSTS: Record<SearchModule, string> = {
  agents: 'core', projects: 'project', calendar: 'calendar', messages: 'message', elearning: 'elearning',
};

function item(kind: SearchItem['kind'], id: number, title = `${kind} ${id}`): SearchItem {
  return { kind, id, title, excerpt: null, parent_id: null, updated_at: '2026-11-26T10:00:00Z' };
}

type Reply = SearchItem[] | number | 'hang' | 'garbage' | 'not-json';

/** A `fetch` answering each API from `replies` (by host), recording every call. */
function fakeFetch(replies: Partial<Record<SearchModule, Reply>>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const module = (Object.keys(HOSTS) as SearchModule[]).find((key) => HOSTS[key] === url.hostname)!;
    const reply = replies[module] ?? [];
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    if (reply === 'not-json') return new Response('<p>Anne "Dupont" anne.dupont@mairie.fr</p>', { status: 200 });
    if (reply === 'garbage') return new Response(JSON.stringify({ results: 'nope' }), { status: 200 });
    if (typeof reply === 'number') return new Response('{}', { status: reply });
    return new Response(JSON.stringify({ items: reply }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function app(options: GlobalSearchOptions) {
  const server = express();
  server.get('/search', globalSearchHandler(options));
  server.use(errorHandler({ onError: () => undefined }));
  return server;
}

const asCaller = (req: request.Test) => req.set('Authorization', `Bearer ${TOKEN}`);

beforeEach(() => {
  for (const [module, service] of Object.entries(SEARCH_SERVICES)) process.env[`${service}_URL`] = `http://${HOSTS[module as SearchModule]}:3000`;
});
afterEach(() => {
  for (const service of Object.values(SEARCH_SERVICES)) delete process.env[`${service}_URL`];
  jest.restoreAllMocks();
});

describe('MAIR-1229 global search of the BFFs', () => {
  test('queries every business API in parallel with the caller token and merges the results by module', async () => {
    const { fetch, calls } = fakeFetch({
      agents: [item('agent', 4, 'Anne Dupont')],
      projects: [item('project', 7), { ...item('task', 9), parent_id: 7 }],
      messages: [item('message', 3)],
    });

    const res = await asCaller(request(app({ fetch })).get('/search?q=%20Dupont%20&limit=5'));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(GlobalSearchResponseSchema.parse(res.body)).toEqual({
      groups: [
        { module: 'agents', items: [item('agent', 4, 'Anne Dupont')] },
        { module: 'projects', items: [item('project', 7), { ...item('task', 9), parent_id: 7 }] },
        { module: 'messages', items: [item('message', 3)] },
      ],
      unavailable: [],
    });
    expect(calls.map(({ url }) => url.hostname).sort()).toEqual(['calendar', 'core', 'elearning', 'message', 'project']);
    for (const { url, headers } of calls) {
      expect(url.pathname).toBe('/api/v1/search');
      expect(url.searchParams.get('q')).toBe('Dupont');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test('the limit is 8 by default', async () => {
    const { fetch, calls } = fakeFetch({});
    await asCaller(request(app({ fetch })).get('/search?q=ab'));
    expect(calls.every(({ url }) => url.searchParams.get('limit') === '8')).toBe(true);
  });

  test('an API that fails, answers out of contract, times out or is not configured is unavailable, not an error', async () => {
    delete process.env.ELEARNING_API_URL;
    const logs = captureLogs();
    const { fetch } = fakeFetch({ agents: 503, projects: 'garbage', calendar: 'hang', messages: [item('message', 1)] });

    const res = await asCaller(request(app({ fetch, timeoutMs: 50 })).get('/search?q=secret-term'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [{ module: 'messages', items: [item('message', 1)] }],
      unavailable: ['agents', 'projects', 'calendar', 'elearning'],
    });
    const warnings = logs.filter((line) => line.message === 'search upstream unavailable');
    expect(warnings.map((line) => line.upstream)).toEqual(['CORE_API', 'PROJECT_API', 'CALENDAR_API', 'ELEARNING_API']);
    // Neither the term nor the token is ever logged.
    expect(JSON.stringify(logs)).not.toMatch(/secret-term|header\.payload/);
  });

  test('a body that is not JSON or out of contract is never quoted in the logs', async () => {
    const logs = captureLogs();
    const { fetch } = fakeFetch({ agents: 'not-json', projects: [{ ...item('task', 1), kind: 'secret-kind' } as unknown as SearchItem] });

    const res = await asCaller(request(app({ fetch })).get('/search?q=ab'));

    expect(res.body.unavailable).toEqual(['agents', 'projects']);
    expect(JSON.stringify(logs)).not.toMatch(/anne|Dupont|secret-kind/i);
  });

  test('a session an API refuses is a 401', async () => {
    const { fetch } = fakeFetch({ projects: 401, messages: [item('message', 1)] });

    const res = await asCaller(request(app({ fetch })).get('/search?q=ab'));

    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  test('without a Bearer token, 401 before any upstream call', async () => {
    const { fetch } = fakeFetch({});

    const res = await request(app({ fetch })).get('/search?q=ab');

    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['a missing term', '', 'query.q'],
    ['a one-character term once trimmed', '?q=%20a%20', 'query.q'],
    ['a term over 100 characters', `?q=${'a'.repeat(101)}`, 'query.q'],
    ['a control character', '?q=ab%0A', 'query.q'],
    ['a limit of 0', '?q=ab&limit=0', 'query.limit'],
    ['a limit over 20', '?q=ab&limit=21', 'query.limit'],
    ['a limit that is not an integer', '?q=ab&limit=abc', 'query.limit'],
    ['a decimal limit', '?q=ab&limit=2.5', 'query.limit'],
  ])('%s is a 400 naming the field, before any upstream call', async (_label, query, path) => {
    const { fetch } = fakeFetch({});

    const res = await asCaller(request(app({ fetch })).get(`/search${query}`));

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(ErrorResponseSchema.parse(res.body).error.details.map((detail) => detail.path)).toContain(path);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('only the requested modules are queried', async () => {
    const { fetch, calls } = fakeFetch({ calendar: [item('event', 2)] });

    const answer = await globalSearch({ headers: { authorization: `Bearer ${TOKEN}` } }, { q: 'ab' }, { fetch, modules: ['calendar'] });

    expect(answer).toEqual({ groups: [{ module: 'calendar', items: [item('event', 2)] }], unavailable: [] });
    expect(calls).toHaveLength(1);
  });
});
