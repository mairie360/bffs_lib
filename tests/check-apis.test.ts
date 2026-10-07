import express from 'express';
import request from 'supertest';
import { baseUrl, checkApis, checkApisResponseSchema } from '../src';

function buildApp(probes: Parameters<typeof checkApis>[0], onUnreachable = jest.fn()) {
  const app = express();
  app.get('/check_apis', checkApis(probes, { onUnreachable }));
  return { app, onUnreachable };
}

describe('checkApis', () => {
  const Schema = checkApisResponseSchema(['core_api', 'user_bff']);

  it('answers 200 when every upstream answers', async () => {
    const { app, onUnreachable } = buildApp({ core_api: async () => 'up', user_bff: async () => 'up' });
    const res = await request(app).get('/check_apis');
    expect(res.status).toBe(200);
    expect(Schema.parse(res.body)).toEqual({ status: 'OK', core_api: 'Connected', user_bff: 'Connected' });
    expect(onUnreachable).not.toHaveBeenCalled();
  });

  it('answers 502 and reports each unreachable upstream, including a probe that throws synchronously', async () => {
    delete process.env.USER_BFF_URL;
    const failure = new Error('ECONNREFUSED');
    const { app, onUnreachable } = buildApp({
      core_api: () => Promise.reject(failure),
      user_bff: () => Promise.resolve(baseUrl('USER_BFF')),
    });
    const res = await request(app).get('/check_apis');
    expect(res.status).toBe(502);
    expect(Schema.parse(res.body)).toEqual({ status: 'Error', core_api: 'Unreachable', user_bff: 'Unreachable' });
    expect(onUnreachable).toHaveBeenCalledWith('core_api', failure);
    expect(onUnreachable).toHaveBeenCalledWith('user_bff', expect.objectContaining({ status: 503 }));
  });

  it('logs a warning by default', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = express();
    app.get('/check_apis', checkApis({ core_api: () => Promise.reject(new Error('down')), other: () => Promise.reject('nope') }));
    await request(app).get('/check_apis');
    expect(warn).toHaveBeenCalledWith('[check_apis] core_api unreachable: Error: down');
    expect(warn).toHaveBeenCalledWith('[check_apis] other unreachable: nope');
    warn.mockRestore();
  });

  it('rejects an answer with an unknown state', () => {
    expect(Schema.safeParse({ status: 'OK', core_api: 'Maybe', user_bff: 'Connected' }).success).toBe(false);
  });
});
