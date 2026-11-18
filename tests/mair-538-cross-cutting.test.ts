import express from 'express';
import request from 'supertest';
import * as lib from '../src';
import {
  ERROR_CODES,
  ErrorDetailSchema,
  ErrorResponseSchema,
  HttpError,
  buildErrorResponse,
  callUpstream,
  codeForStatus,
  defaultMessage,
  errorHandler,
  httpErrorBody,
  upstreamError,
  withRetry,
} from '../src';

/** What axios throws when the upstream does not answer within `timeout`: no `response`, code ECONNABORTED. */
function timeoutError(): Error {
  return Object.assign(new Error('timeout of 10000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
}

describe('MAIR-538 upstream timeout (ECONNABORTED)', () => {
  it('upstreamError answers 502 naming the service, and keeps the timeout as the cause', () => {
    const error = upstreamError('CORE_API', timeoutError());
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
    expect(error.message).toBe('The CORE_API service is unavailable.');
    expect((error.cause as { code?: string }).code).toBe('ECONNABORTED');
  });

  it('withRetry runs an idempotent call again after a timeout', async () => {
    const call = jest.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce('ok');
    await expect(withRetry(call, { delayMs: 1 })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('withRetry gives up after its retries and rethrows the timeout', async () => {
    const call = jest.fn().mockRejectedValue(timeoutError());
    await expect(withRetry(call, { retries: 2, delayMs: 1 })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('callUpstream without retry fails once with a 502, and with retry only after the extra attempt', async () => {
    const once = jest.fn().mockRejectedValue(timeoutError());
    await expect(callUpstream('CALENDAR_API', once)).rejects.toMatchObject({ status: 502 });
    expect(once).toHaveBeenCalledTimes(1);

    const twice = jest.fn().mockRejectedValue(timeoutError());
    await expect(callUpstream('CALENDAR_API', twice, { retry: { delayMs: 1 } })).rejects.toMatchObject({
      status: 502,
      message: 'The CALENDAR_API service is unavailable.',
    });
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('never retries a timeout when the route is not idempotent (no retry option)', async () => {
    const call = jest.fn().mockRejectedValue(timeoutError());
    await expect(callUpstream('MESSAGE_API', call, { retryRateLimited: { delayMs: 1 } })).rejects.toMatchObject({ status: 502 });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('MAIR-538 errorHandler statuses 413, 422 and 504', () => {
  function buildApp(onError = jest.fn()) {
    const app = express();
    app.use(express.json());
    app.post('/echo', (_req, res) => res.json({ ok: true }));
    app.get('/422', () => {
      throw new HttpError(422, undefined, { details: [{ path: 'body.name', message: 'unprocessable' }] });
    });
    app.get('/504', () => {
      throw new HttpError(504);
    });
    app.get('/plain-422', () => {
      throw Object.assign(new Error('raw validator message'), { status: 422 });
    });
    app.use(errorHandler({ onError }));
    return { app, onError };
  }

  it('a body above the JSON limit is a 413 PAYLOAD_TOO_LARGE envelope, not a 500, and is not reported', async () => {
    const { app, onError } = buildApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(ErrorResponseSchema.parse(res.body).error).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
      details: [],
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a body under the limit still goes through', async () => {
    const res = await request(buildApp().app).post('/echo').send({ blob: 'x'.repeat(1024) });
    expect(res.status).toBe(200);
  });

  it('an HttpError 422 keeps its code, default message and details', async () => {
    const res = await request(buildApp().app).get('/422');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: { code: 'UNPROCESSABLE_ENTITY', message: 'Unprocessable request', details: [{ path: 'body.name', message: 'unprocessable' }] },
    });
  });

  it('a non-HttpError carrying status 422 gets the generic message, never its own', async () => {
    const res = await request(buildApp().app).get('/plain-422');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'UNPROCESSABLE_ENTITY', message: 'Unprocessable request' });
    expect(JSON.stringify(res.body)).not.toContain('raw validator message');
  });

  it('an HttpError 504 is GATEWAY_TIMEOUT and is reported as a 5xx', async () => {
    const { app, onError } = buildApp();
    const res = await request(app).get('/504');
    expect(res.status).toBe(504);
    expect(res.body.error).toMatchObject({ code: 'GATEWAY_TIMEOUT', message: 'Upstream service timed out' });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('MAIR-538 error codes and envelope', () => {
  it('codeForStatus and defaultMessage cover 413, 422 and 504', () => {
    expect(codeForStatus(413)).toBe('PAYLOAD_TOO_LARGE');
    expect(codeForStatus(422)).toBe('UNPROCESSABLE_ENTITY');
    expect(codeForStatus(504)).toBe('GATEWAY_TIMEOUT');
    expect(defaultMessage('PAYLOAD_TOO_LARGE')).toBe('Request body too large');
    expect(defaultMessage('UNPROCESSABLE_ENTITY')).toBe('Unprocessable request');
    expect(defaultMessage('GATEWAY_TIMEOUT')).toBe('Upstream service timed out');
  });

  it('unlisted statuses fall back to BAD_REQUEST (4xx) or INTERNAL_ERROR (anything else)', () => {
    expect(codeForStatus(418)).toBe('BAD_REQUEST');
    expect(codeForStatus(507)).toBe('INTERNAL_ERROR');
    expect(codeForStatus(302)).toBe('INTERNAL_ERROR');
  });

  it('ERROR_CODES maps every key to its own name, and every code has a message', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
      expect(defaultMessage(value).length).toBeGreaterThan(0);
    }
    expect(Object.keys(ERROR_CODES).sort()).toEqual([
      'BAD_GATEWAY',
      'BAD_REQUEST',
      'CONFLICT',
      'FORBIDDEN',
      'GATEWAY_TIMEOUT',
      'INTERNAL_ERROR',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'SERVICE_UNAVAILABLE',
      'TOO_MANY_REQUESTS',
      'UNAUTHORIZED',
      'UNPROCESSABLE_ENTITY',
    ]);
  });

  it('buildErrorResponse defaults details to [] and httpErrorBody mirrors the HttpError', () => {
    expect(buildErrorResponse('NOT_FOUND', 'gone')).toEqual({ error: { code: 'NOT_FOUND', message: 'gone', details: [] } });
    const error = new HttpError(409, 'taken', { details: [{ message: 'dup' }] });
    expect(httpErrorBody(error)).toEqual({ error: { code: 'CONFLICT', message: 'taken', details: [{ message: 'dup' }] } });
  });

  it('the schemas accept the envelope and refuse an unknown code or a missing details array', () => {
    expect(ErrorDetailSchema.safeParse({ message: 'x' }).success).toBe(true);
    expect(ErrorDetailSchema.safeParse({ path: 'body.a' }).success).toBe(false);
    expect(ErrorResponseSchema.safeParse(buildErrorResponse('BAD_REQUEST', 'x')).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: { code: 'NOPE', message: 'x', details: [] } }).success).toBe(false);
    expect(ErrorResponseSchema.safeParse({ error: { code: 'BAD_REQUEST', message: 'x' } }).success).toBe(false);
  });
});

describe('MAIR-538 public surface of the lib (src/index.ts)', () => {
  // src/index.ts is excluded from coverage: this list is what makes a removed or renamed export fail.
  it('exports exactly the documented runtime API', () => {
    expect(Object.keys(lib).sort()).toEqual([
      'CLIENT_IP_HEADER',
      'DEFAULT_CONCURRENCY',
      'DEFAULT_MAX_TTL_SECONDS',
      'DEFAULT_USAGE_PERIOD_MS',
      'DEFAULT_USAGE_RETAINED_PERIODS',
      'DEFAULT_USAGE_THRESHOLD',
      'ERROR_CODES',
      'ErrorDetailSchema',
      'ErrorResponseSchema',
      'HttpError',
      'INVALID_SESSION_MESSAGE',
      'INVALID_TOKEN_MESSAGE',
      'LOG_FORMATS',
      'LOG_LEVELS',
      'MemoryCache',
      'PARIS_TIME_ZONE',
      'PROJECT_TASK_MANAGER_ROLES',
      'REQUEST_ID_HEADER',
      'ReachabilitySchema',
      'RedactingSpanExporter',
      'SESSION_JWT_AUDIENCE',
      'SESSION_JWT_ISSUER',
      'SESSION_NOT_CONFIGURED_MESSAGE',
      'SHUTDOWN_TIMEOUT_MS',
      'TELEMETRY_ATTRIBUTES',
      'TELEMETRY_SHUTDOWN_TIMEOUT_MS',
      'UNTRACED_PATHS',
      'UPSTREAM_TIMEOUT_MS',
      'USAGE_METRICS_PATH',
      'VALIDATION_FAILED_MESSAGE',
      'activeTelemetry',
      'addDays',
      'apiOnlyHeaders',
      'asAnonymousClient',
      'asCaller',
      'assertConfigured',
      'authorization',
      'baseUrl',
      'bearerToken',
      'buildErrorResponse',
      'callUpstream',
      'callerKey',
      'checkApis',
      'checkApisResponseSchema',
      'clientIp',
      'codeForStatus',
      'createLogger',
      'createRateLimiter',
      'createTtlRedis',
      'createUsageLedger',
      'defaultMessage',
      'describeError',
      'diagLogger',
      'errorHandler',
      'fromIoredis',
      'fromNodeRedis',
      'gracefulShutdown',
      'hasRole',
      'httpErrorBody',
      'logger',
      'mapUpstreamError',
      'mapWithConcurrency',
      'maskValues',
      'monthBounds',
      'noStore',
      'notFoundHandler',
      'parisDate',
      'parisDateWindow',
      'parseRequest',
      'parseSessionPublicKeys',
      'parseTrustProxy',
      'readOffsetPages',
      'redactSpan',
      'requestId',
      'requestLogger',
      'requireBearer',
      'requireSession',
      'roleKey',
      'securityHeaders',
      'sessionKey',
      'sessionKeysFromEnv',
      'sessionRole',
      'sessionUserId',
      'startTelemetry',
      'telemetryEnabled',
      'textField',
      'unverifiedSubject',
      'upstreamError',
      'upstreamRetryAfterSeconds',
      'upstreamStatus',
      'urlTemplate',
      'usageMetricsHandler',
      'usageMiddleware',
      'utcToWallClock',
      'validationError',
      'verifiedSession',
      'verifySessionToken',
      'wallClockToUtc',
      'withRateLimitRetry',
      'withRetry',
      'withoutSession',
      'zonedToday',
    ]);
  });
});
