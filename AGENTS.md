# Rucola — Agent Instructions

## Mission

Rucola is a private mobile app for exactly two people in a long-distance relationship. It is **not a chat app**. The core idea is **one thing waiting for you from the person you love**.

Treat this as a real product codebase, but prefer simple, understandable solutions over enterprise ceremony.

The product source of truth is `docs/PRODUCT_SPEC.md`. The implementation plan is `docs/DEVELOPMENT_ROADMAP.md`. Architecture constraints live in `docs/ARCHITECTURE.md`.

## Current stack and workflow

- Expo + React Native + TypeScript.
- Android is the primary target.
- Use Expo development builds / `expo prebuild`; do not design around Expo Go.
- Local persistence uses `expo-sqlite`.
- Local photo/video files use app-owned document storage.
- The local database is the source of truth for permanent history.
- `main` is the stable integration branch; do feature/chore work on focused branches created from `main`. Never implement directly on `main`.
- The owner is intentionally keeping the UI barebones for now. Prioritize complete behavior, correct state, persistence, and architecture over visual polish.
- Figma/reference assets are for the later UI pass unless a task explicitly requires them.

## Before changing code

1. Read `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and the relevant section of `docs/DEVELOPMENT_ROADMAP.md`.
2. Inspect the existing implementation and dependencies before introducing patterns or packages.
3. Preserve the product invariants below.
4. Keep changes focused and reviewable. Clean up stale/duplicate code when it is clearly part of the area being changed.
5. Do not claim a build or test was run unless it was actually run.

## Architecture

Use this dependency direction:

```text
React Native screens
        ↓
application/presentation state
        ↓
domain use cases
        ↓
repository interfaces
        ↓
SQLite persistence

CloudClient ← SyncEngine → SQLite sync state
       ↓
future/parallel cloud mailbox
```

Screens must not depend directly on SQLite or HTTP. Domain code must not depend on React Native. Repository interfaces describe capabilities; the SQLite implementation is replaceable.

Synchronization is now a real client-side foundation, not merely future architecture: `CloudClient`, durable sync state/outbox/inbox, and `SyncEngine` exist in `main`. However, they are not yet wired into the app's pairing/lifecycle and the encryption codec is still an abstraction.

## Product invariants

- One relationship per device, exactly two participants once paired.
- At most one active message per participant; the normal lifecycle gives the partner a seeded active message during setup and gives the user an active message when they first send one.
- Sending a new message moves that participant's previous active message into immutable history.
- Messages are immutable: no editing, deleting, replies, threads, or reactions in the initial product.
- History contains both participants' messages and is permanent local data.
- The phone is the permanent data store; the cloud is only a temporary mailbox.
- The Home screen focuses on the partner's current message.
- After three days without a newer partner message, Home transitions to a gentle stale/waiting prompt; the old message remains in History. This behavior is a product requirement but is not yet implemented.
- Do not implement fake `read`/`unread` semantics. Delivery/synchronization is not the same as the user seeing a message.
- Offline-first is fundamental. UI consumes local repositories/state.
- Message ordering must survive offline bursts: A, B, C must all be preserved even though C is the current active message.
- User-facing pairing is exactly five emojis. Technical invitation credentials remain invisible implementation details.

## Message types

- `TEXT`: content required.
- `EMOJI`: the emoji itself is the message.
- `PHOTO_VIDEO`: optional text; media-only is valid. Video is first-class.
- `DRAWING`: planned, but not part of the initial usable feature set until a real editor exists.

Photo/video uses the system library/camera picker, copies the selected asset into app-owned document storage, persists that reference with the message, and renders it on home/history/calendar. Drawing remains a real-editor TODO; do not fake it by storing invented paths or placeholder media.

## Current implementation status

The React Native implementation currently has:

- Expo/RN/TypeScript foundation and Android development build setup.
- Local SQLite schema and repository, currently at schema v5.
- Relationship setup with partner name, own name, and optional together-since date.
- Partner active-message home screen.
- Local text and emoji message creation and active-message replacement.
- Local photo/video selection and camera capture with durable media storage.
- Immutable local history, including media messages.
- Month/date calendar browsing of historical messages, including media messages.
- Local-data reset from settings, including cleanup of owned media files.
- Domain use-case boundary used by the app screens.
- Explicit legacy/schema migration handling through v5.
- Node domain/use-case tests and native SQLite/repository integration coverage.
- Typed `CloudClient` transport for pairing, sync, ACK and media operations.
- Durable SQLite sync state, outbox/inbox, retry/backoff and blocked-item handling.
- `SyncEngine` with ordered outgoing sync, inbound cursor commit, ACK retry and concurrent-run coalescing.

The UI is deliberately barebones. Do not spend the current implementation phase on Figma fidelity.

## Pairing

Real two-device pairing requires the remote service and must **not** be faked as local-only communication.

The intended eventual flow is:

```text
unpaired
  ↓
create invitation
  ↓
show five emojis
  ↓
partner uses the five-emoji flow
  ↓
server validates secure invitation
  ↓
paired relationship
```

The five-emoji sequence is the user-facing mechanism, not a security credential. The real invitation token is separate and has expiry/one-time semantics.

The mobile transport for bootstrap/create/accept exists, but onboarding has not integrated it yet. Until that happens and two real devices are tested, do not claim pairing is complete.

## Onboarding

The intended first-run flow is:

1. Rucola opening/logo;
2. pair with your person;
3. partner name;
4. your name;
5. together-since date or skip;
6. Home.

The conceptual order matters now; detailed visual treatment and transitions belong to the later Figma/UX pass.

Do not add an avatar/tutorial step unless explicitly requested. Partner avatar support is deferred.

## History and calendar

- History is immutable and local.
- Active messages are not history.
- History includes both participants.
- Calendar marks days containing historical messages and opens that day's messages.
- Media messages must remain viewable from both history and calendar.
- Navigation/interaction order should remain coherent even while visual polish is deferred.

## Settings / relationship lifecycle

`Clear local data` is a destructive local reset and may remove the local relationship, messages, and owned media from this device.

This is **not** the same as the eventual unpair flow. Eventual unpairing must preserve local history and make the app read-only. Do not silently implement one as the other.

## Cloud direction and integration boundary

The cloud implementation lives on `cloud/research` and uses Cloudflare Workers + D1 + R2. It includes pairing, authenticated sync push/pull/ACK, durable receipts, media reservation/upload/completion, cleanup and database invariants.

PR #15 is currently open to fix directional mailbox ownership so a device only receives/ACKs partner-originated mailbox deliveries. Treat that hardening as pending until merged and validated.

The mobile cloud foundation is already merged into `main`, but these pieces are not yet integrated into the product lifecycle:

- SecureStore credential persistence;
- pairing UI/onboarding;
- automatic/background sync scheduling;
- real E2E encryption;
- end-to-end media synchronization;
- production cloud endpoint/configuration.

The server remains a temporary mailbox and must never become the permanent history source.

## Testing and validation

Tests are required for important domain/repository behavior:

- message creation;
- replacing an active message;
- moving the previous active message into history;
- ordering;
- persistence;
- one-active-message-per-participant invariant;
- migration and malformed-data handling;
- media cleanup and failure recovery;
- synchronization ordering, cursor durability and ACK behavior;
- directional mailbox ownership once the cloud hardening PR is merged;
- the three-day Home rule once it is represented in testable application/domain logic.

Current validation includes Node domain/use-case tests, cloud-client/sync-engine tests, and a native SQLite/repository integration runner using disposable databases. Keep the native suite separate from Node tests; it exercises real Expo SQLite behavior and must not touch the normal `rucola.db`.

Relevant local commands:

```bash
npm ci
npm run typecheck
npm run test:domain
npm run test:cloud-client
npm run test:sync-engine
npx expo prebuild
npm run android
```

If native/build validation cannot be performed by an agent, state that explicitly. Do not fabricate results.

## Git workflow

- `main` is the stable integration branch.
- Work on a focused `feature/*`, `fix/*`, `test/*`, `chore/*`, `docs/*`, or research branch created from `main`; never implement directly on `main`.
- Keep commits small and understandable.
- Do not commit secrets, generated build output, IDE state, or machine-specific configuration.
- Review the final diff for stale files, duplicate implementations, unused code, and contradictory documentation.
- Update documentation when architecture or behavior changes.
