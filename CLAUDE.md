# CLAUDE.md

Guidance for Claude Code in this repository. Read `../CLAUDE.md` and `../../CLAUDE.md` first.

## What this repo is

`@mairie360/bffs-lib`: a small TypeScript library (CommonJS, built with `tsc` into `dist/`) shared by the
seven BFFs. It is **not** a service. Peer dependencies: `express` 5 and `zod` 4; runtime dependencies:
`helmet`, `express-rate-limit`. No `axios` dependency: upstream errors are recognised by shape.

Scope: MAIR-234 brought one error envelope `{ error: { code, message, details } }`, Express final handlers that
keep the status, upstream error mapping (undeclared 4xx -> 502), `Europe/Paris` date helpers. MAIR-429/430/431 (02/10 audit) added everything the BFFs used to copy: Bearer
handling, upstream URL/options/error mapping/retry, request validation, `check_apis`, security headers and
rate limiting. When a BFF needs a variant, extend the lib instead of copying code back into the BFF.

## Commands

```bash
npm ci
npm run lint
npm run build      # tsc -p tsconfig.build.json -> dist/
npm test           # jest, coverage thresholds 90%
```

## Layout

- `src/error-codes.ts`: codes, status -> code, generic messages
- `src/schema.ts`: zod envelope schemas (used by BFF contracts)
- `src/errors.ts`: `HttpError`
- `src/handlers.ts`: `notFoundHandler`, `errorHandler`
- `src/describe-error.ts`: `describeError`, `maskValues` (MAIR-290)
- `src/upstream.ts`: `mapUpstreamError`, `upstreamError`, `callUpstream`, `withRetry`, `asCaller`, `withoutSession` (MAIR-430)
- `src/dates.ts`: Paris date helpers
- `src/auth.ts`: Bearer extraction (`authorization`, `requireBearer`), unverified `sub`, `noStore`, `parseTrustProxy` (MAIR-429)
- `src/session.ts`: session tokens verified by the BFF (MAIR-474): `verifySessionToken` (HS256 with `JWT_SECRET`, `exp`
  without leeway, positive integer `sub`), `requireSession` (401 before any upstream call, 503 without `JWT_SECRET`),
  `sessionUserId` / `verifiedSession`. Use them for any access decision; `requireBearer` and `unverifiedSubject` only
  check the shape and stay for the transition. Revocation and archived accounts are still checked upstream.
- `src/config.ts`: `baseUrl`, `assertConfigured` (MAIR-431)
- `src/validation.ts`: `validationError`, `parseRequest` (MAIR-430)
- `src/check-apis.ts`: `checkApis`, `checkApisResponseSchema` (MAIR-430)
- `src/security.ts`: `securityHeaders`, `apiOnlyHeaders`, `createRateLimiter`, `sessionKey` (MAIR-430)
- `src/index.ts`: the public API; anything not exported here is private

## Rules

- Never forward upstream messages or bodies to clients, and never leak the message of an unexpected error.
- Never log an error as is (MAIR-290): an `HttpError` from `upstreamError` / `callUpstream` keeps the axios error as `cause`, whose `config.headers` hold the caller's Bearer token and `config.data` / `response.data` the request and response bodies. Log `describeError(error)` (name, status, code, method and path of the call, masked message, cause chain, stack frames); `errorHandler` and `checkApis` do by default, a custom `onError` still receives the original error. The CICD's log marker test (`gdpr_marker` job) searches every container's logs for a marker user's values.
- A BFF must not answer a status its contract does not declare.
- The only accepted credential is `Authorization: Bearer <token>`; do not add cookie or custom-header fallbacks.
- Upstream URLs are `<SERVICE>_URL` (+ `_PORT`), read per call; never a `localhost` default, never read at import time.
- A change to the envelope is a breaking change for the fronts: flag it with `!` in the commit.
- English everywhere (see `../../CLAUDE.md`). CI/CD: `.github/workflows/cicd.yml` calls `mairie360/CICD` `bffs-lib-cicd.yml`; semantic-release publishes to GitHub Packages.
- Lockfile: CI runs npm 11, so regenerate it with `npx -y npm@11 install` and check with `npx -y npm@11 ci`.
