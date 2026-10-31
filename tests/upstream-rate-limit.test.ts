// MAIR-562: an upstream 429 was answered 502 and never retried, so the BFFs lost writes to the
// Calendar API rate limit. It is now relayed as a 429 with `Retry-After`, and retried after it.
import express from 'express';
import request from 'supertest';
import {
  HttpError,
  callUpstream,
  errorHandler,
  mapUpstreamError,
  upstreamError,
  upstreamRetryAfterSeconds,
  withRateLimitRetry,
  withRetry,
} from '../src';

afterEach(() => jest.useRealTimers());

const rateLimited = (headers: unknown = { 'retry-after': '1' }) =>
  Object.assign(new Error('Request failed with status code 429'), { isAxiosError: true, response: { status: 429, headers } });
const answered = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });

describe('upstreamRetryAfterSeconds', () => {
  it('reads delay-seconds from plain and axios-like headers', () => {
    expect(upstreamRetryAfterSeconds(rateLimited({ 'Retry-After': '3' }))).toBe(3);
    expect(upstreamRetryAfterSeconds(rateLimited({ 'retry-after': ['4'] }))).toBe(4);
    expect(upstreamRetryAfterSeconds(rateLimited({ get: (name: string) => (name === 'retry-after' ? 5 : undefined) }))).toBe(5);
    expect(upstreamRetryAfterSeconds({ status: 429, headers: { 'retry-after': ' 2 ' } })).toBe(2);
  });

  it('reads an HTTP date relative to now, never negative', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(upstreamRetryAfterSeconds(rateLimited({ 'retry-after': 'Wed, 14 Oct 2026 12:00:02 GMT' }), now)).toBe(2);
    expect(upstreamRetryAfterSeconds(rateLimited({ 'retry-after': 'Wed, 14 Oct 2026 11:00:00 GMT' }), now)).toBe(0);
  });

  it('is undefined when absent or unreadable', () => {
    expect(upstreamRetryAfterSeconds(rateLimited({}))).toBeUndefined();
    expect(upstreamRetryAfterSeconds(rateLimited({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(upstreamRetryAfterSeconds(rateLimited({ get: () => undefined }))).toBeUndefined();
    expect(upstreamRetryAfterSeconds(rateLimited(null))).toBeUndefined();
    expect(upstreamRetryAfterSeconds('weird')).toBeUndefined();
  });
});

describe('mapping an upstream 429', () => {
  it('relays it as a 429, declared or not, with its Retry-After', () => {
    for (const mapped of [mapUpstreamError(rateLimited({ 'retry-after': '3' })), upstreamError('CALENDAR_API', rateLimited({ 'retry-after': '3' }), [404])]) {
      expect(mapped).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS', retryAfterSeconds: 3 });
      expect(mapped.message).not.toContain('status code');
    }
  });

  it('defaults Retry-After to 1 s', () => {
    expect(mapUpstreamError(rateLimited({})).retryAfterSeconds).toBe(1);
  });

  it('is answered 429 with a Retry-After header, not 502', async () => {
    const app = express();
    app.get('/create', () => {
      throw upstreamError('CALENDAR_API', rateLimited({ 'retry-after': '2' }));
    });
    app.get('/plain', () => {
      throw new HttpError(409);
    });
    app.use(errorHandler({ onError: jest.fn() }));

    const res = await request(app).get('/create');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect((await request(app).get('/plain')).headers['retry-after']).toBeUndefined();
  });
});

describe('retrying an upstream 429', () => {
  it('waits for Retry-After, then succeeds', async () => {
    jest.useFakeTimers();
    const call = jest.fn().mockRejectedValueOnce(rateLimited({ 'retry-after': '1' })).mockResolvedValue('ok');
    const pending = withRateLimitRetry(call);
    await jest.advanceTimersByTimeAsync(999);
    expect(call).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('ok');
  });

  it('waits at least delayMs when Retry-After is missing', async () => {
    jest.useFakeTimers();
    const call = jest.fn().mockRejectedValueOnce(rateLimited({})).mockResolvedValue('ok');
    const pending = withRateLimitRetry(call, { delayMs: 300 });
    await jest.advanceTimersByTimeAsync(299);
    expect(call).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('ok');
  });

  it('gives up at once on a Retry-After longer than maxRetryAfterMs', async () => {
    const call = jest.fn().mockRejectedValue(rateLimited({ 'retry-after': '30' }));
    await expect(withRateLimitRetry(call, { retries: 3 })).rejects.toMatchObject({ response: { status: 429 } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('only retries a 429, never a transient failure (safe for POST)', async () => {
    const call = jest.fn().mockRejectedValue(answered(503));
    await expect(withRateLimitRetry(call, { delayMs: 0 })).rejects.toMatchObject({ response: { status: 503 } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('is part of withRetry', async () => {
    const call = jest.fn().mockRejectedValueOnce(rateLimited({ 'retry-after': '0' })).mockResolvedValue('ok');
    await expect(withRetry(call, { delayMs: 0 })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('answers a 429 when it persists through callUpstream', async () => {
    const call = jest.fn().mockRejectedValue(rateLimited({ 'retry-after': '0' }));
    await expect(callUpstream('CALENDAR_API', call, { retryRateLimited: { retries: 2, delayMs: 0 } })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 0 });
    expect(call).toHaveBeenCalledTimes(3);

    const once = jest.fn().mockRejectedValueOnce(rateLimited({ 'retry-after': '0' })).mockResolvedValue('ok');
    await expect(callUpstream('CALENDAR_API', once, { retryRateLimited: true })).resolves.toBe('ok');

    const transient = jest.fn().mockRejectedValue(answered(502));
    await expect(callUpstream('CALENDAR_API', transient, { retryRateLimited: { delayMs: 0 } })).rejects.toMatchObject({ status: 502 });
    expect(transient).toHaveBeenCalledTimes(1);
  });
});
