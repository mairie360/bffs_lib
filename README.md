# bffs_lib

`@mairie360/bffs-lib`: shared building blocks of the Mairie 360 BFFs (MAIR-234, MAIR-429, MAIR-430, MAIR-431).
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

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```
