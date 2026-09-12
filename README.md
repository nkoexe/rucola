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

Drawing is still a placeholder. Real two-device pairing, backend synchronization, notifications, widgets, and E2E encryption are not implemented yet.

The UI is intentionally barebones while the functional local app is being completed. Detailed Figma implementation comes afterward.

## Architecture

```text
React Native screens/components
        ↓
presentation state/hooks
        ↓
domain use cases
        ↓
RucolaRepository interface
        ↓
SQLite repository
        ↓
expo-sqlite + app-owned media

future:
sync engine → temporary backend/mailbox
```

Local SQLite is the source of truth for history. A future server is a temporary mailbox, not a cloud archive.

## Documentation

Read these before substantial changes:

- [`AGENTS.md`](AGENTS.md) — engineering and product constraints
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — product behavior and MVP scope
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — local-first architecture and sync invariants
- [`docs/REACT_NATIVE_MIGRATION.md`](docs/REACT_NATIVE_MIGRATION.md) — migration status and development roadmap
- [`src/data/README.md`](src/data/README.md) — native SQLite integration-test coverage

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

`main` is the stable baseline. Ongoing implementation happens on `migration/react-native` or a focused feature branch and is merged back to `main` at meaningful milestones.

Keep commits small and reviewable. Never commit generated secrets, local databases, or machine-specific build artifacts.
