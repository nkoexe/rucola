# C3 — Worker Skeleton and Local D1 Test Environment

**Status:** implementation skeleton complete; production deployment intentionally blocked.
**Branch:** `cloud/research`

## What C3 establishes

- Cloudflare Worker in ES module TypeScript format.
- Wrangler JSONC configuration with a local D1 preview binding.
- Numbered D1 migrations under `cloud/worker/migrations/`.
- Workers Vitest integration using `@cloudflare/vitest-plugin` and Vitest 4.
- Automatic application of the initial migration in isolated test storage.
- Typed environment/binding definitions.
- JSON error envelope and no-store response policy.
- Web Crypto SHA-256 credential hashing and bearer-token lookup.
- D1 schema-health checks.
- Reserved API routes for pairing and synchronization that return `501` until their protocol transactions are implemented.

## Deliberate non-goals

C3 does **not** implement pairing acceptance, message push, pull, ACK, R2 uploads, cleanup, E2E encryption, rate limiting, or production provisioning. Returning `501` is intentional; silently accepting or pretending to sync would hide protocol gaps.

## Local workflow

From `cloud/worker/`:

```bash
npm install
npm run migrate:local
npm run dev
npm test
npm run typecheck
```

The D1 local-development model uses Wrangler/Miniflare/workerd rather than a second hand-rolled SQLite server. Production resources are not touched by the local migration command.

## Production safety

`wrangler.jsonc` contains a placeholder production database ID. No real Cloudflare database ID, account ID, secret, credential, or R2 bucket is committed. Production provisioning is a later step after protocol implementation and review.

## C3 acceptance criteria

1. Worker can start locally against a simulated D1 binding.
2. Migration 0001 creates all five C2 tables and indexes.
3. Tests verify database health and required tables.
4. Tests verify bearer authentication uses the stored credential hash and rejects missing credentials.
5. Reserved protocol endpoints cannot accidentally behave like a partially implemented sync service.
6. No production Cloudflare resource is required to run the test suite.
