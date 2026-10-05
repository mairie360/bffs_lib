import { HttpError } from './errors';

/**
 * Base URL of an upstream service from `<SERVICE>_URL` (scheme optional, `http` by default) and
 * `<SERVICE>_PORT` (used only when the URL has no port), without trailing slash.
 *
 * Read on every call, never at import time: `.env` (loaded by `import 'dotenv/config'` on the first
 * line of the entry point), tests and deployments can change it without reloading any module. There is
 * no `localhost` default: a missing or invalid variable is a 503, so a misconfigured BFF never calls
 * the wrong host.
 */
export function baseUrl(service: string): string {
  const configured = process.env[`${service}_URL`]?.trim();
  if (!configured) throw new HttpError(503, `The ${service} service is not configured.`);
  const port = process.env[`${service}_PORT`]?.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(configured) ? configured : `http://${configured}`);
  } catch {
    throw new HttpError(503, `The ${service} service is misconfigured.`);
  }
  if (!url.port && port) {
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new HttpError(503, `The ${service} service is misconfigured.`);
    url.port = port;
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Fail-fast startup check: throws one `Error` naming every service whose `<SERVICE>_URL` is missing or
 * invalid. Call it from the entry point, before `listen`, with every upstream the BFF calls.
 */
export function assertConfigured(services: readonly string[]): void {
  const invalid = services.filter((service) => {
    try {
      baseUrl(service);
      return false;
    } catch {
      return true;
    }
  });
  if (invalid.length > 0) {
    throw new Error(`Missing or invalid upstream configuration: ${invalid.map((service) => `${service}_URL`).join(', ')}`);
  }
}
