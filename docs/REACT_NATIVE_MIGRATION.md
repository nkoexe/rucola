# React Native migration record

## Status

The Kotlin/Jetpack Compose prototype was migrated to **Expo + React Native + TypeScript**. The migration foundation was merged into `main` and is now the stable base for ongoing development.

This document is a **historical migration record**, not the current product roadmap. For current decisions, read:

- `docs/PRODUCT_SPEC.md` — product source of truth
- `docs/DEVELOPMENT_ROADMAP.md` — current implementation plan
- `docs/ARCHITECTURE.md` — current architecture and invariants

The Kotlin implementation remains a behavioral reference, not a code-conversion target.

## Completed migration work

- Expo + React Native + TypeScript application scaffold.
- Android development-build / Expo prebuild workflow.
- Platform-independent domain models, repository interface, and use cases.
- Local-first SQLite persistence with explicit schema versioning.
- Transactional message replacement and active-message slots.
- Deterministic local message ordering and serialized SQLite writes.
- Initialization retry and concurrent initialization hardening.
- Transactional v0/v1 → v2 database migrations with integrity validation.
- Rejection of malformed, incomplete, and unsupported database states.
- Local photo/video picker and camera capture.
- Durable app-owned media storage and media playback.
- Media ownership validation, orphan reconciliation, and reset cleanup.
- Android recovery for pending media-picker results.
- Setup, home, history, calendar, and settings screens wired to domain/use-case APIs.
- Node domain/use-case tests.
- Native SQLite/repository integration coverage, including concurrency, migrations, media lifecycle, and adversarial cases.

## Validation recorded at migration completion

The merged React Native foundation was validated with:

- `npm run typecheck` — passed.
- `npm run test:domain` — **7/7 passed**.
- Native integration runner — **12/12 groups passed**.

The native suite runs against disposable SQLite databases and does not touch the normal `rucola.db`.

These results document the migration milestone; future changes must be validated independently and must not treat these historical results as proof that the current tree still passes.

## Product state at migration completion

At the time of migration completion, Rucola was a tiny private mailbox for exactly two people in a long-distance relationship. It deliberately was **not a chat app**.

The local prototype supported:

- one local relationship;
- onboarding with names and an optional together-since date;
- one active message per participant;
- text and emoji messages;
- photo/video messages with optional captions;
- camera capture and library selection;
- immutable local history;
- calendar browsing;
- local reset with media cleanup.

Drawing was unimplemented, and there was no real two-device pairing, backend synchronization, notifications, widget, or E2E encryption.

The UI was intentionally barebones and Figma-driven visual implementation was deferred.

## Historical architecture at migration completion

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

Screens must not depend directly on SQLite or HTTP. Domain code should remain platform-independent.

Local SQLite is the source of truth for history. A future server is a temporary mailbox, not the archive.

The current architecture has since been documented more precisely in `docs/ARCHITECTURE.md` and the current roadmap has moved beyond the migration itself.

## Migration invariants carried forward

- Exactly one relationship per local installation.
- Exactly two participants once paired.
- At most one active message per participant.
- Sending a new message archives the previous active message instead of deleting it.
- History is immutable local data.
- Messages have stable IDs and deterministic order metadata.
- Sync state is separate from read/seen state; MVP has no read receipts.
- The future server is a temporary mailbox, not the permanent archive.

## Historical pairing direction

The migration work deliberately deferred real pairing until a remote transport existed. The current product decision is now more specific: the **user-facing pairing mechanism is exactly five emojis**, with any secure invitation token kept entirely as an implementation detail.

Do not use this historical document to infer a different user-facing pairing format.

## Development guidance

Prefer small, reviewable commits. Every functional change should include appropriate tests or an explicit reason why a test is not practical.

Do not claim native or device behavior is validated unless it was actually exercised in a native build/device environment.
