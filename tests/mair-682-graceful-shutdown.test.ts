import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { gracefulShutdown, type GracefulShutdown } from '../src';
import { captureLogs } from './support/capture-logs';

/** Server with a slow route, a fast route and an SSE stream that never ends by itself. */
function startServer(): Promise<{ server: Server; url: string; release: () => void }> {
  const app = express();
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  app.get('/fast', (_req, res) => { res.json({ ok: true }); });
  app.get('/slow', async (_req, res) => {
    await released;
    res.json({ done: true });
  });
  app.get('/chunked', async (_req, res) => {
    res.write('start ');
    await released;
    res.end('end');
  });
  app.get('/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(': connected\n\n');
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, release: () => release() });
    });
  });
}

function get(url: string, agent?: http.Agent): Promise<{ status: number; body: string; connection?: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Opens the stream and resolves once its first event arrived, with a promise of its end (wrapped: not adopted). */
function openStream(url: string): Promise<{ ended: Promise<string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      const ended = new Promise<string>((resolveEnd) => res.on('end', () => resolveEnd(body)));
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        resolve({ ended });
      });
    }).on('error', reject);
  });
}

describe('MAIR-682 gracefulShutdown', () => {
  let handle: GracefulShutdown | undefined;
  let server: Server | undefined;

  beforeEach(() => { captureLogs(); });

  afterEach(() => {
    handle?.dispose();
    server?.closeAllConnections();
    server?.close();
    handle = undefined;
    server = undefined;
  });

  it('lets a running request finish, then stops accepting connections and exits with 0', async () => {
    const started = await startServer();
    server = started.server;
    const exit = jest.fn();
    handle = gracefulShutdown(server, { exit, signals: [] });

    const slow = get(`${started.url}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = handle.shutdown('test');
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(get(`${started.url}/fast`)).rejects.toThrow();
    started.release();
    await expect(slow).resolves.toMatchObject({ status: 200, body: '{"done":true}', connection: 'close' });
    await expect(done).resolves.toBe(0);
  });

  it('ends the SSE streams at once instead of waiting for them', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [], timeoutMs: 5_000 });

    const { ended } = await openStream(`${started.url}/stream`);
    const startedAt = Date.now();
    await expect(handle.shutdown('test')).resolves.toBe(0);
    await expect(ended).resolves.toContain(': connected');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('closes idle keep-alive connections so the server closes without waiting for them', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [] });
    const agent = new http.Agent({ keepAlive: true });
    await get(`${started.url}/fast`, agent);

    const startedAt = Date.now();
    await expect(handle.shutdown('test')).resolves.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    agent.destroy();
  });

  it('forces the exit with 1 when a request outlives the timeout', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [], timeoutMs: 100 });

    const slow = get(`${started.url}/slow`).catch(() => 'destroyed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(handle.shutdown('test')).resolves.toBe(1);
    await expect(slow).resolves.toBe('destroyed');
  });

  it('flushes the telemetry after the server closed, bounded in time', async () => {
    const started = await startServer();
    server = started.server;
    const order: string[] = [];
    server.on('close', () => order.push('server closed'));
    const telemetry = { shutdown: jest.fn(async () => { order.push('telemetry flushed'); }) };
    handle = gracefulShutdown(server, { signals: [], telemetry });

    await expect(handle.shutdown('test')).resolves.toBe(0);
    expect(order).toEqual(['server closed', 'telemetry flushed']);
  });

  it('a failing telemetry flush does not block the exit', async () => {
    const started = await startServer();
    server = started.server;
    const telemetry = { shutdown: jest.fn(async () => { throw new Error('collector down'); }) };
    handle = gracefulShutdown(server, { signals: [], telemetry });
    await expect(handle.shutdown('test')).resolves.toBe(0);
  });

  it('handles SIGTERM and SIGINT and runs the drain once', async () => {
    const started = await startServer();
    server = started.server;
    const handlers = new Map<string, () => void>();
    const once = jest.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.once);
    const exit = jest.fn();
    handle = gracefulShutdown(server, { exit });
    once.mockRestore();
    expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);

    handlers.get('SIGTERM')?.();
    handlers.get('SIGINT')?.();
    await handle.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it('ends a keep-alive connection once a response that already sent its head finishes', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [] });
    const agent = new http.Agent({ keepAlive: true });

    const chunked = get(`${started.url}/chunked`, agent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = handle.shutdown('test');
    started.release();
    await expect(chunked).resolves.toMatchObject({ status: 200, body: 'start end' });
    const startedAt = Date.now();
    await expect(done).resolves.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    agent.destroy();
  });

  it('exits the process with the drain result by default', async () => {
    const started = await startServer();
    server = started.server;
    const handlers = new Map<string, () => void>();
    const once = jest.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.once);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    handle = gracefulShutdown(server, { signals: ['SIGTERM'] });
    once.mockRestore();

    handlers.get('SIGTERM')?.();
    await handle.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
});
