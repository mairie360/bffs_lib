import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { logger } from './logger';
import { activeTelemetry, TELEMETRY_SHUTDOWN_TIMEOUT_MS, type Telemetry } from './telemetry';

/** Longest drain after SIGTERM before the process exits anyway, well under the 30 s Kubernetes grace period. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface GracefulShutdownOptions {
  /** Telemetry flushed once the server is closed. Default: the one `startTelemetry` started, if any. */
  telemetry?: Telemetry;
  /** Longest drain before the remaining connections are destroyed and the process exits with 1. */
  timeoutMs?: number;
  /** Signals handled. Default SIGTERM (Kubernetes) and SIGINT (Ctrl+C). */
  signals?: readonly NodeJS.Signals[];
  /** Ends the process; replaced in tests. Default `process.exit`. */
  exit?: (code: number) => void;
}

export interface GracefulShutdown {
  /** Starts the drain (what a signal does); resolves with the exit code once the process may end. */
  shutdown(reason?: string): Promise<number>;
  /** Removes the signal handlers. */
  dispose(): void;
}

function isStream(response: ServerResponse): boolean {
  return String(response.getHeader('content-type') ?? '').startsWith('text/event-stream');
}

/**
 * Stops a BFF cleanly on SIGTERM / SIGINT: the server stops accepting connections, idle keep-alive connections are
 * closed, the responses still running answer with `Connection: close`, the SSE streams are ended at once (they never
 * end by themselves; `EventSource` reconnects to another pod), then the telemetry is flushed and the process exits
 * with 0. After `timeoutMs` the remaining connections are destroyed and the process exits with 1.
 *
 * Call it with the server `app.listen` returns. The image must run an init as PID 1 (`tini`) so the signal reaches
 * Node, and the pod's `preStop` must leave the load balancer the time to stop routing to it.
 */
export function gracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): GracefulShutdown {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const running = new Set<ServerResponse>();
  let stopping = false;
  let done: Promise<number> | undefined;

  const track = (_request: IncomingMessage, response: ServerResponse) => {
    if (stopping && !response.headersSent) response.setHeader('Connection', 'close');
    running.add(response);
    response.once('close', () => running.delete(response));
  };
  // First listener, before the app answers: a request read during the drain must get `Connection: close`.
  server.prependListener('request', track);

  const flush = async (): Promise<void> => {
    const telemetry = options.telemetry ?? activeTelemetry();
    if (!telemetry) return;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, TELEMETRY_SHUTDOWN_TIMEOUT_MS).unref());
    await Promise.race([telemetry.shutdown().catch(() => undefined), timeout]);
  };

  const shutdown = (reason = 'shutdown'): Promise<number> => {
    if (done) return done;
    stopping = true;
    logger.info('shutting down', { reason, running: running.size });
    done = new Promise<number>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const closed = new Promise<number>((resolveClosed) => {
        server.close(() => resolveClosed(0));
        server.closeIdleConnections();
        for (const response of running) {
          if (!response.headersSent) {
            response.setHeader('Connection', 'close');
          } else {
            // Head already sent with keep-alive: the connection would then wait idle for keepAliveTimeout. Once this
            // response is done, the connections left idle are closed; one with a pipelined request still to answer
            // is not idle, and that request gets `Connection: close` from `track`.
            response.once('finish', () => setImmediate(() => server.closeIdleConnections()));
          }
          // An SSE stream never ends by itself, whether or not its head is already sent.
          if (isStream(response)) response.end();
        }
      });
      const forced = new Promise<number>((resolveForced) => {
        timer = setTimeout(() => {
          logger.warn('shutdown timeout: closing the remaining connections', { running: running.size });
          server.closeAllConnections();
          resolveForced(1);
        }, timeoutMs);
        timer.unref();
      });
      void Promise.race([closed, forced]).then(async (code) => {
        clearTimeout(timer);
        await flush();
        resolve(code);
      });
    });
    return done;
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  let exiting = false;
  for (const signal of signals) {
    // A second signal (Ctrl+C twice, SIGTERM then SIGINT) joins the running drain and exits once.
    const handler = () => {
      if (exiting) return;
      exiting = true;
      void shutdown(signal).then(exit);
    };
    handlers.set(signal, handler);
    // `on`, not `once`: a second signal during the drain must find the handler, not Node's default (exit).
    process.on(signal, handler);
  }

  return {
    shutdown,
    dispose: () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      server.off('request', track);
    },
  };
}
