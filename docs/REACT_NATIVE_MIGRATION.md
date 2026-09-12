# React Native migration

## Status

The Kotlin/Jetpack Compose prototype has been migrated to **Expo + React Native + TypeScript**. The migration foundation was merged into `main` and is now the stable base for ongoing development.

The Kotlin implementation remains a behavioral reference, not a code-conversion target.

### Completed

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

## Current validation

The merged React Native foundation was validated with:

- `npm run typecheck` — passed.
- `npm run test:domain` — **7/7 passed**.
- Native integration runner — **12/12 groups passed**.

The native suite runs against disposable SQLite databases and does not touch the normal `rucola.db`.

## Current product state

Rucola is a tiny private mailbox for exactly two people in a long-distance relationship. It is deliberately **not a chat app**.

The local prototype currently supports:

- one local relationship;
- onboarding with names and an optional together-since date;
- one active message per participant;
- text and emoji messages;
- photo/video messages with optional captions;
- camera capture and library selection;
- immutable local history;
- calendar browsing;
- local reset with media cleanup.

Drawing is still unimplemented. There is currently no real two-device pairing, backend synchronization, notifications, widgets, or E2E encryption.

The UI is intentionally barebones. Figma-driven visual implementation is a later phase, after the functional local app is complete.

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

Screens must not depend directly on SQLite or HTTP. Domain code should remain platform-independent.

Local SQLite is the source of truth for history. A future server is a temporary mailbox, not the archive.

## Product invariants

- Exactly one relationship per local account/device.
- Exactly two participants: `ME` and `PARTNER`.
- At most one active message per participant.
- Sending a new message archives the previous active message instead of deleting it.
- History is immutable local data.
- Messages have stable IDs and deterministic order metadata.
- Sync state is separate from read/seen state; MVP has no read receipts.
- The future server is a temporary mailbox, not the permanent archive.

## Next phase: app-layer completion

The next priority is a complete, usable local vertical slice rather than more infrastructure work:

1. finish startup/loading/error state handling;
2. verify onboarding → home flow on a real device;
3. verify text/emoji send and active/history transitions;
4. finish photo/video picker and camera flows;
5. verify history and calendar behavior;
6. verify reset and restart persistence;
7. harden offline/device edge cases;
8. implement the real drawing composer.

After the local feature set is stable, move to the Figma/UI pass. Backend pairing and synchronization should follow that, with the offline ordering model solved before remote sync is implemented.

## Pairing direction

Pairing is intentionally deferred until a remote transport exists. The planned flow is:

```text
unpaired
  ↓
create invitation
  ↓
share deep link / cute human-facing code
  ↓
partner submits invitation
  ↓
server validates secure token
  ↓
paired relationship
```

The human-facing code is only a usability aid. The secure invitation token must have real entropy, expire after a limited period (target 24 hours), and become invalid after successful pairing.

Do not make the human-facing code the security credential.

## Development guidance

Prefer small, reviewable commits. Every functional change should include appropriate tests or an explicit reason why a test is not practical.

Do not claim native or device behavior is validated unless it was actually exercised in a native build/device environment.
