# Rucola

Rucola is a tiny private mobile mailbox for two people in a long-distance relationship.

> **One thing waiting for you from the person you love.**

It is intentionally **not a conventional chat app**. Each person has one active message; sending a new message moves their previous active message into permanent local history.

## Development workstreams

Rucola currently has two active development workstreams:

- `migration/react-native` — mobile application and local-first client;
- `cloud/research` — production synchronization backend and cloud protocol.

They are intentionally developed in parallel. The mobile application must remain useful without the backend, and the backend must treat local devices as the durable source of truth.

## Mobile implementation

The current mobile stack is:

- Expo + React Native + TypeScript
- Android development builds / Expo prebuild
- `expo-sqlite` for local persistence
- `expo-image-picker` + `expo-file-system` for durable local photo/video messages
- `expo-video` for local video playback
- domain/use-case layer over the repository boundary

The prototype supports local onboarding, partner active-message home, text, emoji, photo/video selection and camera capture, durable local media references, captions, immutable history, calendar browsing and local-data reset.

Drawing is still a placeholder. Real two-device synchronization, notifications, widgets and E2E encryption are not yet integrated into the mobile branch.

## Cloud implementation

The production cloud backend uses:

- Cloudflare Worker — API, authentication, pairing and synchronization orchestration;
- D1 — relationships, devices, invitations, temporary mailbox state, durable message receipts and media metadata;
- R2 — temporary media storage, currently being integrated.

The cloud is a **temporary synchronization mailbox, not a cloud archive**. Local SQLite remains the permanent source of truth.

The current retention contract is finite: unacknowledged mailbox messages are guaranteed for 14 days, while durable message receipts are retained for 30 days after acceptance. Initial media limits are 20 MB for images and 100 MB for videos.

Read these documents before substantial backend changes:

- [`docs/CLOUD_ARCHITECTURE.md`](docs/CLOUD_ARCHITECTURE.md) — current cloud protocol and boundaries;
- [`docs/MEDIA_LIFECYCLE.md`](docs/MEDIA_LIFECYCLE.md) — cloud media state machine;
- [`docs/CLOUD_HARDENING.md`](docs/CLOUD_HARDENING.md) — security/correctness audit and remaining implementation work.

For general product/client architecture:

- [`AGENTS.md`](AGENTS.md) — engineering and product constraints;
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — product behavior and MVP scope;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — overall local-first architecture;
- [`docs/REACT_NATIVE_MIGRATION.md`](docs/REACT_NATIVE_MIGRATION.md) — migration status.

## Mobile development

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

The project is intended to use an Expo development build rather than Expo Go because future features require native capabilities.

## Cloud development

From `cloud/worker/`:

```bash
npm ci
npm test
npm run typecheck
```

Apply local D1 migrations when needed:

```bash
npm run migrate:local
```

R2 integration and media upload endpoints are not yet part of the implemented API.

## Design

Rucola should feel pastel, cutesy, playful, handmade and slightly wonky rather than like a generic Material app.

Figma is the visual reference for the later UI pass. Functional behavior, local correctness and synchronization semantics take priority while the feature set is being stabilized.

## Git workflow

Develop on `migration/react-native`, `cloud/research`, or a focused feature branch. Keep commits small and reviewable and never develop directly on `main`.
