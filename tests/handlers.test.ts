import express from 'express';
import request from 'supertest';
import { ErrorResponseSchema, HttpError, createLogger, errorHandler, mapUpstreamError, notFoundHandler, requestLogger } from '../src';
import { captureLogs } from './support/capture-logs';

function buildApp(onError = jest.fn()) {
  const app = express();
  app.use(express.json());
  app.get('/http', () => {
    throw new HttpError(409, 'Already exists', { details: [{ path: 'body.name', message: 'taken' }] });
  });
  app.get('/default', () => {
    throw new HttpError(403);
  });
  app.get('/boom', () => {
    throw new Error('secret db password');
  });
  app.get('/upstream-500', () => {
    throw new HttpError(503);
  });
  app.get('/upstream-4xx', () => {
    throw mapUpstreamError({ response: { status: 418 } }, [404]);
  });
  app.get('/sent', (_req, res) => {
    res.write('partial');
    throw new Error('late');
  });
  app.post('/json', (_req, res) => res.json({ ok: true }));
  app.use(notFoundHandler);
  app.use(errorHandler({ onError }));
  return { app, onError };
}

describe('error handlers', () => {
  it('answers unknown routes with the envelope', async () => {
    const res = await request(buildApp().app).get('/nope');
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('keeps the status, code, message and details of an HttpError', async () => {
    const res = await request(buildApp().app).get('/http');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message: 'Already exists', details: [{ path: 'body.name', message: 'taken' }] },
    });
  });

  it('uses a generic message when an HttpError has none', async () => {
    const res = await request(buildApp().app).get('/default');
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'FORBIDDEN', message: 'Access denied', details: [] });
  });

  it('maps malformed JSON bodies to a 400 envelope', async () => {
    const res = await request(buildApp().app).post('/json').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body).error.code).toBe('BAD_REQUEST');
  });

  it('answers unexpected errors with a 500 that does not leak the message', async () => {
    const { app, onError } = buildApp();
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports 5xx HttpErrors but not 4xx ones', async () => {
    const { app, onError } = buildApp();
    await request(app).get('/http');
    expect(onError).not.toHaveBeenCalled();
    const res = await request(app).get('/upstream-500');
    expect(res.status).toBe(503);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never answers an undeclared upstream 4xx', async () => {
    const res = await request(buildApp().app).get('/upstream-4xx');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BAD_GATEWAY');
  });

  it('delegates to Express when headers are already sent', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/sent').catch((e) => e);
    expect(res.status === undefined || res.status === 200).toBe(true);
  });

  it('writes one JSON error line by default, with the request id', async () => {
    const logs = captureLogs();
    const app = express();
    app.use(requestLogger());
    app.get('/boom', () => {
      throw new Error('x');
    });
    app.use(errorHandler());
    const res = await request(app).get('/boom').set('X-Request-Id', 'req-12345678');
    jest.restoreAllMocks();
    expect(logs[0]).toEqual(
      expect.objectContaining({ level: 'ERROR', target: 'bff', message: 'request failed', request_id: 'req-12345678', status: 500 }),
    );
    expect(logs[0].error).toMatch(/^Error: x\n/);
    expect(logs[1]).toEqual(expect.objectContaining({ message: 'request completed', status: 500, path: '/boom' }));
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('writes to the logger it is given', async () => {
    const logger = { ...createLogger(), error: jest.fn() };
    const app = express();
    app.get('/upstream', () => {
      throw new HttpError(502);
    });
    app.use(errorHandler({ logger }));
    await request(app).get('/upstream');
    expect(logger.error).toHaveBeenCalledWith('request failed', expect.objectContaining({ status: 502, request_id: undefined }));
  });
});
