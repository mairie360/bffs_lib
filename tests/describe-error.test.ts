import { inspect } from 'node:util';
import express from 'express';
import request from 'supertest';
import { asCaller, callUpstream, checkApis, describeError, errorHandler, HttpError, maskValues, upstreamError } from '../src';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJlbWFya2Vy';
const EMAIL = 'gdpr.markerqzkfjwxa@example.com';
const PASSWORD = 'Mkqzkfjw!4821WXYZ';
const PHONE = '0612349876';
const VALUES = [TOKEN, EMAIL, PASSWORD, PHONE, 'markerqzkfjwxa', 'c2lnbmF0dXJlbWFya2Vy'];

function expectClean(text: string): void {
  for (const value of VALUES) expect(text).not.toContain(value);
}

/** The shape of an axios error: the request options (headers, body) and the upstream answer it keeps. */
function axiosError(options: { status?: number; code: string; headers?: Record<string, string> }): Error {
  const config = {
    method: 'post',
    url: `/api/v1/auth/login?email=${encodeURIComponent(EMAIL)}`,
    baseURL: 'http://core:3000',
    headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
    data: JSON.stringify({ email: EMAIL, password: PASSWORD, phone: PHONE }),
  };
  const error = new Error(options.status ? `Request failed with status code ${options.status}` : `connect ${options.code} 172.18.0.5:3000`);
  return Object.assign(error, {
    name: 'AxiosError',
    isAxiosError: true,
    code: options.code,
    config,
    request: { _header: `POST /api/v1/auth/login HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\n` },
    response: options.status ? { status: options.status, data: { email: EMAIL, phone: PHONE }, config } : undefined,
  });
}

describe('describeError', () => {
  it('logging an upstream failure as is would print the token and the bodies', () => {
    // What errorHandler used to log: the reason for describeError.
    const dumped = inspect(upstreamError('CORE_API', axiosError({ status: 500, code: 'ERR_BAD_RESPONSE' })), { depth: 5 });
    expect(dumped).toContain(TOKEN);
    expect(dumped).toContain(PASSWORD);
  });

  it('keeps the type and context of each error of the chain, without the values', () => {
    const description = describeError(upstreamError('CORE_API', axiosError({ status: 500, code: 'ERR_BAD_RESPONSE' })));
    const [first, second] = description.split('\n');
    expect(first).toBe('HttpError 502 BAD_GATEWAY: Upstream service error');
    expect(second).toBe('  caused by AxiosError 500 ERR_BAD_RESPONSE POST /api/v1/auth/login: Request failed with status code 500');
    expect(description).toMatch(/\n {4}at /);
    expectClean(description);
  });

  it('describes an upstream that never answered', () => {
    const description = describeError(upstreamError('CORE_API', axiosError({ code: 'ECONNREFUSED' })));
    expect(description.split('\n').slice(0, 2)).toEqual([
      'HttpError 502 BAD_GATEWAY: The CORE_API service is unavailable.',
      '  caused by AxiosError ECONNREFUSED POST /api/v1/auth/login: connect ECONNREFUSED 172.18.0.5:3000',
    ]);
  });

  it('masks the values a message quotes', () => {
    let parseError: unknown;
    try {
      JSON.parse(`"${EMAIL}`);
    } catch (error) {
      parseError = error;
    }
    expectClean(describeError(parseError));
    expect(maskValues(`no account for ${EMAIL}, phone ${PHONE} or +33 6 12 34 98 76`)).toBe('no account for <email>, phone <number> or <number>');
    expect(maskValues(`token Bearer ${TOKEN} and ${TOKEN}`)).toBe('token Bearer … and <jwt>');
    expect(maskValues(`Cannot read properties of undefined (reading 'name')`)).toBe("Cannot read properties of undefined (reading '…')");
    expect(maskValues('timeout of 10000ms exceeded')).toBe('timeout of 10000ms exceeded');
  });

  it('handles anything thrown, and cycles in the cause chain', () => {
    expect(describeError(`no account for ${EMAIL}`)).toBe('no account for <email>');
    expect(describeError(null)).toBe('object thrown');
    const a = new Error('a') as Error & { cause?: unknown };
    const b = Object.assign(new Error('b'), { cause: a });
    a.cause = b;
    expect(describeError(a).split('\n').filter((line) => line.startsWith('  caused by'))).toEqual(['  caused by Error: b']);
  });
});

describe('error handler with an Authorization header (MAIR-290)', () => {
  // A route that calls an upstream on behalf of the caller, the way every BFF does, through a client that
  // fails with the options it was given (as axios does).
  function buildApp(failure: { status?: number; code: string }) {
    const app = express();
    app.use(express.json());
    app.post('/login', async (req, _res, next) => {
      try {
        await callUpstream('CORE_API', async () => {
          const options = asCaller('CORE_API', req);
          const error = axiosError(failure);
          Object.assign((error as unknown as { config: object }).config, { headers: options.headers, data: JSON.stringify(req.body) });
          throw error;
        });
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler());
    return app;
  }

  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, CORE_API_URL: 'http://core', CORE_API_PORT: '3000' };
  });
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it.each([
    ['a 5xx answer', { status: 500, code: 'ERR_BAD_RESPONSE' }],
    ['no answer', { code: 'ECONNREFUSED' }],
  ])('logs %s without the token nor the bodies', async (_label, failure) => {
    const logged: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 10 }))).join(' '));
    });
    const res = await request(buildApp(failure))
      .post('/login')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ email: EMAIL, password: PASSWORD, phone: PHONE });

    expect(res.status).toBe(502);
    expectClean(JSON.stringify(res.body));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^HttpError 502 BAD_GATEWAY/);
    expect(logged[0]).toContain('caused by AxiosError');
    expectClean(logged[0]);
  });

  it('still hands the original error to a custom onError', async () => {
    const onError = jest.fn();
    const app = express();
    app.get('/boom', () => {
      throw new HttpError(503, undefined, { cause: axiosError({ code: 'ETIMEDOUT' }) });
    });
    app.use(errorHandler({ onError }));
    await request(app).get('/boom');
    expect(onError).toHaveBeenCalledWith(expect.any(HttpError));
  });
});

describe('checkApis default report', () => {
  it('logs the unreachable upstream without the values', async () => {
    const warned: string[] = [];
    jest.spyOn(console, 'warn').mockImplementation((message: string) => {
      warned.push(message);
    });
    const app = express();
    app.get('/check_apis', checkApis({ core_api: () => Promise.reject(axiosError({ status: 503, code: 'ERR_BAD_RESPONSE' })) }));
    const res = await request(app).get('/check_apis');
    expect(res.status).toBe(502);
    expect(warned[0]).toMatch(/^\[check_apis\] core_api unreachable: AxiosError 503 ERR_BAD_RESPONSE POST \/api\/v1\/auth\/login/);
    expectClean(warned.join('\n'));
    jest.restoreAllMocks();
  });
});
