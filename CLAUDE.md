# CLAUDE.md

Guidance for Claude Code in this repository. Read `../CLAUDE.md` and `../../CLAUDE.md` first.

## What this repo is

`@mairie360/bffs-lib`: a small TypeScript library (CommonJS, built with `tsc` into `dist/`) shared by the
seven BFFs. It is **not** a service. Peer dependencies: `express` 5 and `zod` 4.

Scope of MAIR-234: one error envelope `{ error: { code, message, details } }`, Express final handlers that
keep the status, upstream error mapping (undeclared 4xx -> 502), `Europe/Paris` date helpers.

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
- `src/upstream.ts`: `mapUpstreamError`
- `src/dates.ts`: Paris date helpers
- `src/index.ts`: the public API; anything not exported here is private

## Rules

- Never forward upstream messages or bodies to clients, and never leak the message of an unexpected error.
- A BFF must not answer a status its contract does not declare.
- A change to the envelope is a breaking change for the fronts: flag it with `!` in the commit.
- English everywhere (see `../../CLAUDE.md`). CI/CD (workflows, release config, renovate) is not set up yet.
