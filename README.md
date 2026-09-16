# Rucola

Rucola is a tiny private mobile mailbox for two people in a long-distance relationship.

> **One thing waiting for you from the person you love.**

It is intentionally **not a chat app**. Each person has one active message; sending a new message moves their previous active message into permanent local history.

## Current state

The application is built with:

- Expo + React Native + TypeScript
- Android development builds / Expo prebuild
- `expo-sqlite` for local persistence
- `expo-image-picker` + `expo-file-system` for durable local photo/video messages
- `expo-video` for local video playback
- a domain/use-case layer over the repository boundary
- a typed cloud client and durable local sync state/outbox

The local application currently supports:

- onboarding with partner name, own name, and optional together-since date;
- one active message per participant;
- local text and emoji messages;
- local photo/video selection and camera capture;
- durable app-owned media;
- photo/video messages with optional captions;
- immutable message history;
- month/date calendar browsing;
- local reset including owned-media cleanup;
- schema migrations through SQLite schema version 5;
- durable sync state, outbox/inbox persistence, and a tested `SyncEngine` foundation.

The cloud client foundation is merged into `main`, including typed pairing, sync, ACK, and media transport. It is **not yet wired into the app's pairing/UI lifecycle**, credentials are not yet persisted in SecureStore, and automatic/background synchronization is not implemented. Media synchronization is also intentionally blocked in the current `SyncEngine` until the end-to-end media path is integrated.

The production cloud backend is developed separately on `cloud/research`. Its Worker/D1 implementation includes pairing, sync push/pull/ACK, durable message receipts, media reservation/upload/completion, and cleanup. PR #15 (`fix/cloud-mailbox-direction`) is currently open to enforce directional mailbox ownership before that cloud work is considered stable.

Still not implemented in the product: real user-facing five-emoji two-device pairing, end-to-end online message exchange, three-day stale Home behavior, notifications, widgets, drawing, and E2E encryption.

The UI is intentionally barebones while the functional product is being completed. Detailed Figma implementation comes afterward.

## Documentation

Use these documents as the current sources of truth:

- [`AGENTS.md`](AGENTS.md) — engineering constraints and development workflow
- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior, scope, and UX direction
- [`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md) — phased implementation plan and current milestones
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — application architecture and persistence/synchronization invariants
- [`docs/REACT_NATIVE_MIGRATION.md`](docs/REACT_NATIVE_MIGRATION.md) — historical migration record
- [`docs/NATIVE_SQLITE_TEST_PLAN.md`](docs/NATIVE_SQLITE_TEST_PLAN.md) — native SQLite integration-test status and coverage
- [`src/data/README.md`](src/data/README.md) — native SQLite integration-test coverage

Cloud-specific implementation documentation currently lives on the `cloud/research` branch while that workstream remains separate from `main`.

`docs/PRODUCT_SPEC.md` replaces the older `docs/PRODUCT.md`; the latter is intentionally no longer maintained.

## Development

Install dependencies:

```bash
npm ci
```

Run TypeScript validation:

```bash
npm run typecheck
```

Run the domain/use-case test suite:

```bash
npm run test:domain
```

Run the cloud-client transport tests:

```bash
npm run test:cloud-client
```

Run the sync-engine tests:

```bash
npm run test:sync-engine
```

Generate/update the native project:

```bash
npx expo prebuild
```

Run Android:

```bash
npm run android
```

The project uses an Expo development build rather than Expo Go because native capabilities are required.

The native SQLite integration suite is available through the development-only integration test screen and uses disposable databases.

## Design

Rucola should feel pastel, cutesy, playful, handmade and slightly wonky rather than like a generic Material app.

Figma is the visual reference for the later UI pass.

## Git workflow

`main` is the stable integration baseline. Ongoing implementation happens on focused `feature/*`, `fix/*`, `test/*`, `chore/*`, `docs/*`, or research branches created from `main`.

Keep commits small and reviewable. Never commit generated secrets, local databases, or machine-specific build artifacts.
