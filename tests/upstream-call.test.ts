import { z } from 'zod';
import { HttpError, UPSTREAM_TIMEOUT_MS, asCaller, callUpstream, mapUpstreamError, upstreamError, withRetry, withoutSession } from '../src';

const ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ENV };
  jest.useRealTimers();
});

const unanswered = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3000'), { isAxiosError: true, response: undefined });
const answered = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });
const zodError = () => {
  const result = z.object({ id: z.number() }).safeParse({});
  if (result.success) throw new Error('unreachable');
  return result.error;
};

describe('mapUpstreamError cause', () => {
  it('keeps the original error as cause, never as message', () => {
    const original = answered(500);
    const mapped = mapUpstreamError(original);
    expect(mapped.cause).toBe(original);
    expect(mapped.message).not.toContain('500');
  });
});

describe('upstreamError', () => {
  it('passes an HttpError through', () => {
    const error = new HttpError(503);
    expect(upstreamError('CORE_API', error)).toBe(error);
  });

  it('maps an unanswered call to a 502 naming the service', () => {
    const error = upstreamError('CORE_API', unanswered());
    expect(error).toMatchObject({ status: 502, message: 'The CORE_API service is unavailable.' });
    expect(error.message).not.toContain('10.0.0.1');
  });

  it('maps an unparsable answer to a 502', () => {
    expect(upstreamError('CORE_API', zodError())).toMatchObject({ status: 502, message: 'The CORE_API answer is invalid.' });
  });

  it('relays declared 4xx only', () => {
    expect(upstreamError('CORE_API', answered(404), [404]).status).toBe(404);
    expect(upstreamError('CORE_API', answered(403), [404]).status).toBe(502);
    expect(upstreamError('CORE_API', answered(500), [500]).status).toBe(502);
    expect(upstreamError('CORE_API', new Error('boom')).status).toBe(502);
  });
});

describe('withRetry', () => {
  it('retries transient failures, then succeeds', async () => {
    const call = jest.fn().mockRejectedValueOnce(unanswered()).mockRejectedValueOnce(answered(503)).mockResolvedValue('ok');
    await expect(withRetry(call, { retries: 2, delayMs: 0 })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('gives up after the allowed retries', async () => {
    const call = jest.fn().mockRejectedValue(answered(502));
    await expect(withRetry(call, { delayMs: 0 })).rejects.toMatchObject({ response: { status: 502 } });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('waits 200 ms by default before retrying', async () => {
    jest.useFakeTimers();
    const call = jest.fn().mockRejectedValueOnce(answered(504)).mockResolvedValue('ok');
    const pending = withRetry(call);
    await jest.advanceTimersByTimeAsync(199);
    expect(call).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('ok');
  });

  it.each([
    ['a 4xx', answered(404)],
    ['a 500', answered(500)],
    ['an HttpError', new HttpError(503)],
    ['a plain error', new Error('bug')],
    ['a non-object', 'weird'],
  ])('does not retry %s', async (_label, error) => {
    const call = jest.fn().mockRejectedValue(error);
    await expect(withRetry(call, { retries: 3, delayMs: 0 })).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('callUpstream', () => {
  it('returns the answer', async () => {
    await expect(callUpstream('CORE_API', async () => ({ data: 1 }))).resolves.toEqual({ data: 1 });
  });

  it('maps failures with the declared statuses', async () => {
    await expect(callUpstream('CORE_API', () => Promise.reject(answered(404)), { declared: [404] })).rejects.toMatchObject({ status: 404 });
    await expect(callUpstream('CORE_API', () => Promise.reject(answered(404)))).rejects.toMatchObject({ status: 502 });
  });

  it('retries only when asked', async () => {
    const once = jest.fn().mockRejectedValueOnce(unanswered()).mockResolvedValue('ok');
    await expect(callUpstream('CORE_API', once)).rejects.toMatchObject({ status: 502 });

    const retried = jest.fn().mockRejectedValueOnce(unanswered()).mockResolvedValue('ok');
    await expect(callUpstream('CORE_API', retried, { retry: { delayMs: 0 } })).resolves.toBe('ok');

    jest.useFakeTimers();
    const defaults = jest.fn().mockRejectedValueOnce(unanswered()).mockResolvedValue('ok');
    const pending = callUpstream('CORE_API', defaults, { retry: true });
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBe('ok');
    expect(defaults).toHaveBeenCalledTimes(2);
  });
});

describe('asCaller / withoutSession', () => {
  const req = (authorization?: string) => ({ headers: { authorization } });

  it('builds the options of a call on behalf of the caller', () => {
    process.env.CORE_API_URL = 'core-api:3000';
    expect(asCaller('CORE_API', req('bearer tok'))).toEqual({
      baseURL: 'http://core-api:3000',
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: { Authorization: 'Bearer tok' },
    });
    expect(asCaller('CORE_API', req('Bearer tok'), 5_000).timeout).toBe(5_000);
  });

  it('checks the session before the configuration', () => {
    delete process.env.CORE_API_URL;
    expect(() => asCaller('CORE_API', req())).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => asCaller('CORE_API', req('Bearer tok'))).toThrow(expect.objectContaining({ status: 503 }));
  });

  it('builds the options of a call without session', () => {
    process.env.CORE_API_URL = 'http://core-api:3000';
    expect(withoutSession('CORE_API')).toEqual({ baseURL: 'http://core-api:3000', timeout: UPSTREAM_TIMEOUT_MS });
    expect(withoutSession('CORE_API', 2_000).timeout).toBe(2_000);
  });
});
