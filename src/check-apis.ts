import type { RequestHandler } from 'express';
import { z } from 'zod';

/** One probe per upstream, keyed by its name in the answer (`core_api`, `user_bff`...). */
export type UpstreamProbes = Readonly<Record<string, () => Promise<unknown>>>;

export const ReachabilitySchema = z.enum(['Connected', 'Unreachable']);

/**
 * Schema of the `/check_apis` answer for these upstream names:
 * `{ status: 'OK' | 'Error', <name>: 'Connected' | 'Unreachable', ... }`. Register it in the BFF's
 * OpenAPI registry (`registry.register('CheckApisResponse', checkApisResponseSchema(['core_api']))`)
 * and declare it for both the 200 and the 502.
 */
export function checkApisResponseSchema<const K extends string>(names: readonly K[]) {
  const services = Object.fromEntries(names.map((name) => [name, ReachabilitySchema])) as Record<K, typeof ReachabilitySchema>;
  return z.object({ status: z.enum(['OK', 'Error']), ...services });
}

export interface CheckApisOptions {
  /** Called for each unreachable upstream. Defaults to a `console.warn` with the name and the error message. */
  onUnreachable?: (name: string, error: unknown) => void;
}

/**
 * `GET /check_apis` handler: runs every probe (typically the upstream's `health` operation with
 * `withoutSession(...)`) in parallel and answers 200 when all succeed, 502 otherwise. A probe that throws
 * synchronously (e.g. `baseUrl` on a missing variable) counts as unreachable.
 */
export function checkApis(probes: UpstreamProbes, options: CheckApisOptions = {}): RequestHandler {
  const report =
    options.onUnreachable ??
    ((name: string, error: unknown) => console.warn(`[check_apis] ${name} unreachable: ${error instanceof Error ? error.message : String(error)}`));
  return async (_req, res) => {
    const entries = Object.entries(probes);
    const results = await Promise.allSettled(entries.map(async ([, probe]) => probe()));
    const services = entries.map(([name], index) => {
      const result = results[index];
      if (result.status === 'rejected') report(name, result.reason);
      return [name, result.status === 'fulfilled' ? 'Connected' : 'Unreachable'] as const;
    });
    const ok = services.every(([, state]) => state === 'Connected');
    res.status(ok ? 200 : 502).json({ status: ok ? 'OK' : 'Error', ...Object.fromEntries(services) });
  };
}
