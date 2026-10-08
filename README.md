# bffs_lib

`@mairie360/bffs-lib`: shared building blocks of the Mairie 360 BFFs (MAIR-234, MAIR-429, MAIR-430, MAIR-431, MAIR-504).
A BFF must use these instead of keeping its own copy.

## Error envelope

Every BFF answers errors with one shape, declared in its OpenAPI contract:

```json
{ "error": { "code": "CONFLICT", "message": "Already exists", "details": [{ "path": "body.name", "message": "taken" }] } }
```

`details` is always present (empty array when there is nothing to add). `code` is one of `ERROR_CODES`
and is derived from the HTTP status.

## Session (MAIR-429)

A BFF accepts one credential only: `Authorization: Bearer <token>` (the fronts' proxy turns the
`accessToken` cookie into it). Cookies, `x-session-token` and other schemes are ignored.

```ts
import { authorization, requireBearer, noStore, parseTrustProxy, unverifiedSubject } from '@mairie360/bffs-lib';

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use('/projects', noStore, requireBearer, projectsRouter); // 401 before any upstream call

// forward the caller's session, normalised to `Bearer <token>` (401 when missing)
await api.getProjects({ headers: { Authorization: authorization(req) } });

// unverified `sub`: only to shape a request sent upstream with the same token, never to grant access
const userId = unverifiedSubject(authorization(req));
```

## Upstream configuration (MAIR-431)

Every upstream is configured by `<SERVICE>_URL` (scheme optional) and optionally `<SERVICE>_PORT`, read on
every call. There is no `localhost` default.

```ts
// src/index.ts, first line, before any import that could read the environment
import 'dotenv/config';
import { assertConfigured, baseUrl } from '@mairie360/bffs-lib';

assertConfigured(['CORE_API', 'USER_BFF']); // throws at startup, naming every missing/invalid URL

// per call: 503 'The CORE_API service is not configured.' when missing or invalid
await coreApi.getMe({ baseURL: baseUrl('CORE_API') });
```

## Upstream calls, validation, check_apis, security (MAIR-430)

```ts
import {
  asCaller, withoutSession, callUpstream, parseRequest, checkApis, checkApisResponseSchema,
  securityHeaders, apiOnlyHeaders, createRateLimiter, sessionKey, parseTrustProxy,
} from '@mairie360/bffs-lib';

// app.ts
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use(securityHeaders);
app.use(apiOnlyHeaders()); // default-src 'none' everywhere but /docs

// route: 401 without session, 503 when CORE_API_URL is missing, declared 4xx relayed, the rest -> 502
const body = parseRequest(UpdateSchema, req.body, 'body'); // 400 'Validation failed' with body.<field> details
const { data } = await callUpstream('CORE_API', () => coreApi.getMe(asCaller('CORE_API', req)), { declared: [404] });

// idempotent calls only: retry once on no answer / 502 / 503 / 504
await callUpstream('PROJECT_API', () => projectApi.getProjects(asCaller('PROJECT_API', req)), { retry: true });

// /check_apis
registry.register('CheckApisResponse', checkApisResponseSchema(['core_api']));
router.get('/', checkApis({ core_api: () => coreApi.health(withoutSession('CORE_API', 5_000)) }));

// rate limits (in memory, per replica)
router.post('/login', createRateLimiter({ envPrefix: 'AUTH_RATE_LIMIT', keyOf: (req) => req.body?.email ?? '' }), login);
router.use(createRateLimiter({ limit: 30, windowMs: 60_000, failedOnly: false, keyOf: sessionKey }));
```

Never key a rate limit on a `sub` decoded without verification: use `sessionKey` (hash of the token).
For a limit that must hold whatever the caller's IP (failed sign-ins per account, per refresh token), pass
`perIp: false` with `keyOf`.

## Telemetry (MAIR-504)

OpenTelemetry traces and metrics, exported over OTLP (http/protobuf) to the collector of the instance. Off
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (and `OTEL_SDK_DISABLED` is not `true`): tests and local runs
export nothing.

```ts
// src/telemetry.ts
import { startTelemetry } from '@mairie360/bffs-lib';
import { version } from '../package.json';

startTelemetry({ serviceName: 'bff-user', serviceVersion: version });

// src/index.ts: before the app, so that Express is instrumented
import 'dotenv/config';
import './telemetry';
import app from './app';
```

- Spans: incoming requests named after the matched route (`GET /user/:userId`), Express route handlers, and
  outgoing calls, which carry the W3C `traceparent` to the upstream APIs. `/health` is not traced.
- Metrics: `http.server.request.duration` (per method, route, status) and `http.client.request.duration`
  (per upstream host).
- No personal data (MAIR-290, MAIR-501): only `TELEMETRY_ATTRIBUTES` are exported. No URL, query string,
  body, header, client IP or user agent; the path of an outgoing call becomes `url.template`
  (`/api/v1/users/{id}/groups`), status messages are dropped and exceptions keep their type only.
- On SIGTERM / SIGINT the pending telemetry is flushed (at most 5 s), then the signal is raised again.

| Variable | Role |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collector base URL, e.g. `http://otel-collector:4318`; unset = telemetry off |
| `OTEL_SDK_DISABLED` | `true` turns telemetry off even with an endpoint |
| `OTEL_SERVICE_NAME` | overrides `serviceName` |
| `OTEL_RESOURCE_ATTRIBUTES` | extra resource attributes, e.g. `deployment.environment.name=prod` |

## Usage telemetry without identifiers (MAIR-501)

What is used, how much and by how many agents, never who does what:

```ts
import { USAGE_METRICS_PATH, createUsageLedger, usageMetricsHandler, usageMiddleware } from '@mairie360/bffs-lib';

const usage = createUsageLedger({ service: 'bff-user' });
app.use(usageMiddleware(usage)); // first, before the routers
app.get(USAGE_METRICS_PATH, usageMetricsHandler(usage)); // scraped by the instance's collector
```

Counts per route template (never the path or the query), method, status and period (1 h): actions, distinct
users, summed latency. Distinct users come from a hash of the user id (verified by `requireSession`) with a salt
drawn for each period and dropped with the hashes when the period closes. Only closed periods are served, and a
count under the threshold (5) is not: small operations are summed into `other`, dropped too when under the threshold.

## Usage

```ts
import { errorHandler, notFoundHandler, HttpError, mapUpstreamError, ErrorResponseSchema, parisDateWindow } from '@mairie360/bffs-lib';

// app.ts: after every router
app.use(notFoundHandler);
app.use(errorHandler());

// route
throw new HttpError(404, 'Project not found');

// upstream call: only the listed 4xx are relayed, everything else becomes 502
try { await upstream.call(); } catch (e) { throw mapUpstreamError(e, [404]); }

// contract: register once in the BFF's zod-to-openapi registry and reference it from error responses
registry.register('ErrorResponse', ErrorResponseSchema);

// Dashboard window: days computed on the Europe/Paris calendar
const { from, to } = parisDateWindow(30);
```

| Export | Role |
| --- | --- |
| `ErrorResponseSchema`, `ErrorDetailSchema` | zod schemas of the envelope, for the contracts |
| `HttpError` | throwable with status, code, message, details |
| `notFoundHandler`, `errorHandler(options?)` | last two middlewares; the status is preserved, unknown errors become a generic 500 |
| `mapUpstreamError(error, declaredStatuses)` | declared upstream 4xx relayed, undeclared 4xx / 5xx / network errors -> 502 |
| `parisDate`, `addDays`, `parisDateWindow` | `Europe/Paris` calendar helpers |
| `bearerToken(req)`, `authorization(req)`, `requireBearer` | Bearer token of the request; normalised header or 401; middleware form |
| `unverifiedSubject(token)` | numeric `sub` read without verifying the signature (never for access decisions) |
| `baseUrl(service)`, `assertConfigured(services)` | `<SERVICE>_URL`/`_PORT` read per call, 503 when missing or invalid; startup check |
| `noStore`, `parseTrustProxy(value)` | `Cache-Control: no-store` middleware; `TRUST_PROXY` -> Express `trust proxy` |
| `asCaller(service, req)`, `withoutSession(service)` | axios-compatible options `{ baseURL, timeout, headers }` of an upstream call |
| `upstreamError(service, error, declared)`, `callUpstream(service, call, options)` | one mapping of upstream failures: no answer / invalid answer / undeclared status -> 502 |
| `withRetry(call, options)` | retry on no answer, 502, 503, 504; idempotent calls only |
| `validationError(location, issues)`, `parseRequest(schema, value, location)` | 400 `Validation failed` with `<location>.<path>` details |
| `checkApis(probes)`, `checkApisResponseSchema(names)` | `/check_apis` handler (200 / 502) and its contract schema |
| `securityHeaders`, `apiOnlyHeaders(docsPath)` | helmet setup shared by every BFF; strict headers outside `/docs` |
| `createRateLimiter(options)`, `sessionKey(req)` | express-rate-limit with the envelope and `<prefix>_*` env; unforgeable per-session key |
| `startTelemetry(options)`, `telemetryEnabled()` | OpenTelemetry for a BFF, off without `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `redactSpan`, `RedactingSpanExporter`, `urlTemplate`, `TELEMETRY_ATTRIBUTES` | attribute allowlist applied to every exported span |

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```
