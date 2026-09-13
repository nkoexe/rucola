# Rucola

Rucola is a tiny private mobile mailbox for two people in a long-distance relationship.

> **One thing waiting for you from the person you love.**

It is intentionally **not a chat app**. Each person has one active message; sending a new message moves their previous active message into permanent local history.

## Current state

The app is being built with:

- Expo + React Native + TypeScript
- Android development builds / Expo prebuild
- `expo-sqlite` for local persistence
- `expo-image-picker` + `expo-file-system` for durable local photo/video messages
- `expo-video` for local video playback
- a domain/use-case layer over the repository boundary

The local prototype currently supports:

- onboarding with partner name, own name, and optional together-since date;
- one active message per participant;
- local text and emoji messages;
- local photo/video selection and camera capture;
- durable app-owned media;
- photo/video messages with optional captions;
- immutable message history;
- month/date calendar browsing;
- local reset including owned-media cleanup.

Drawing is still unimplemented. Real five-emoji two-device pairing, backend synchronization, notifications, widgets, and E2E encryption are not implemented yet.

The UI is intentionally barebones while the functional local app is being completed. Detailed Figma implementation comes afterward.

## Documentation

Use these documents as the current sources of truth:

- [`AGENTS.md`](AGENTS.md) — engineering constraints and development workflow
- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior, scope, and UX direction
- [`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md) — phased implementation plan and milestones
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — application architecture and persistence/synchronization invariants
- [`docs/REACT_NATIVE_MIGRATION.md`](docs/REACT_NATIVE_MIGRATION.md) — historical migration record
- [`src/data/README.md`](src/data/README.md) — native SQLite integration-test coverage

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

`main` is the stable integration baseline. Ongoing implementation happens on focused `feature/*`, `fix/*`, `test/*`, `chore/*`, or research branches created from `main`.

Keep commits small and reviewable. Never commit generated secrets, local databases, or machine-specific build artifacts.
