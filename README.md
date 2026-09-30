# bffs_lib

`@mairie360/bffs-lib`: shared building blocks of the Mairie 360 BFFs (MAIR-234).

## Error envelope

Every BFF answers errors with one shape, declared in its OpenAPI contract:

```json
{ "error": { "code": "CONFLICT", "message": "Already exists", "details": [{ "path": "body.name", "message": "taken" }] } }
```

`details` is always present (empty array when there is nothing to add). `code` is one of `ERROR_CODES`
and is derived from the HTTP status.

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

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```
