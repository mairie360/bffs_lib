import http, { type Server } from 'node:http';
import net from 'node:net';
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
  app.get('/stream-later', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    await released;
    if (!res.writableEnded) res.write(': late\n\n');
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
    const on = jest.spyOn(process, 'on').mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    const exit = jest.fn();
    handle = gracefulShutdown(server, { exit });
    on.mockRestore();
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
    const on = jest.spyOn(process, 'on').mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    handle = gracefulShutdown(server, { signals: ['SIGTERM'] });
    on.mockRestore();

    handlers.get('SIGTERM')?.();
    await handle.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
  it('answers a request that reaches the server during the drain with Connection: close', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [] });
    const done = handle.shutdown('test');

    // A request already read from an open connection is still served, but asks the client not to reuse the socket.
    const request = new http.IncomingMessage(new net.Socket());
    const response = new http.ServerResponse(request);
    server.emit('request', request, response);
    expect(response.getHeader('connection')).toBe('close');
    response.emit('close');
    await expect(done).resolves.toBe(0);
  });

  it('works with the defaults alone', async () => {
    const started = await startServer();
    server = started.server;
    const before = process.listenerCount('SIGTERM');
    handle = gracefulShutdown(server);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    handle.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('ends an SSE stream whose head is not sent yet', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [], timeoutMs: 5_000 });

    const stream = get(`${started.url}/stream-later`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    await expect(handle.shutdown('test')).resolves.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(stream).resolves.toMatchObject({ status: 200, connection: 'close' });
    started.release();
  });

  it('keeps the socket of a pipelined response that is still queued', async () => {
    const started = await startServer();
    server = started.server;
    handle = gracefulShutdown(server, { signals: [] });
    const { port } = server.address() as AddressInfo;

    // Head of /chunked sent before SIGTERM, /fast queued behind it on the same connection.
    const socket = net.connect(port, '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.write('GET /chunked HTTP/1.1\r\nHost: x\r\n\r\nGET /fast HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = handle.shutdown('test');
    started.release();
    await expect(done).resolves.toBe(0);
    await closed;
    expect(raw).toContain('start ');
    expect(raw).toContain('{"ok":true}');
  });

  it('keeps handling the signal during the drain, so a second SIGTERM does not kill the process', async () => {
    const started = await startServer();
    server = started.server;
    const before = process.listenerCount('SIGTERM');
    const exit = jest.fn();
    handle = gracefulShutdown(server, { exit, signals: ['SIGTERM'] });
    const listeners = process.listeners('SIGTERM');
    const handler = listeners[listeners.length - 1] as () => void;
    handler();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    handler();
    await handle.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
