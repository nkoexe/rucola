# Rucola — Agent Instructions

## Mission

Rucola is a private mobile app for exactly two people in a long-distance relationship. It is **not** a chat app. The core idea is **one thing waiting for you from the person you love**.

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
- Figma/reference assets are for the later UI pass unless a task explicitly requires them. Design files live in `reference/`.

## Before changing code

1. Read `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and the relevant section of `docs/DEVELOPMENT_ROADMAP.md`.
2. Inspect the existing implementation and dependencies before introducing patterns or packages.
3. Preserve the product invariants below.
4. Keep changes focused and reviewable. Clean up stale/duplicate code when it is clearly part of the area being changed.
5. Do not claim a build or test was run unless it was actually run.

## Architecture

Use this dependency direction:

```text
React Native screens/components
        ↓
application bootstrap + presentation state
        ↓
domain use cases
        ↓
repository interfaces
        ↓
SQLite persistence

SyncEngine ↔ durable SQLite sync state
        ↓
CloudClient
        ↓
temporary backend/mailbox
```

Screens must not depend directly on SQLite or HTTP. Domain code must not depend on React Native. Repository interfaces describe capabilities; the SQLite implementation is replaceable.

The mobile sync foundation is already present. `CloudClient` owns typed HTTP protocol access, while `SyncEngine` owns push/pull/ACK coordination and durable cursor/outbox semantics. Do not describe networking as wholly unimplemented.

The application now owns pairing credentials and the foreground sync lifecycle through `CloudRuntime`. Do not claim the complete two-device milestone is validated until real Android devices have exercised pairing, encrypted exchange, offline recovery, and reset.

## Product invariants

- One relationship per device, exactly two participants once paired.
- At most one active message per participant; the normal lifecycle gives the partner a seeded active message during setup and gives the user an active message when they first send one.
- Sending a new message moves that participant's previous active message into immutable history.
- Messages are immutable: no editing, deleting, replies, threads, or reactions in the initial product.
- History contains both participants' messages and is permanent local data.
- The phone is the permanent data store; the cloud service is only a temporary mailbox/transport layer.
- The Home screen focuses on the partner's current message.
- After three days without a newer partner message, Home transitions to a gentle stale/waiting prompt; the old message remains in History. This is not yet fully implemented end-to-end.
- Do not implement fake `read`/`unread` semantics. Delivery/synchronization is not the same as the user seeing a message.
- Offline-first is fundamental. UI consumes local repositories/state.
- Message ordering must survive offline bursts: A, B, C must all be preserved even though C is the current active message.
- User-facing pairing is exactly five emojis. Technical invitation credentials remain invisible implementation details.

## Message types

- `TEXT`: content required.
- `EMOJI`: the emoji itself is the message.
- `PHOTO_VIDEO`: optional text; media-only is valid. Video is first-class.
- `DRAWING`: planned, but not part of the initial usable feature set until a real editor exists.

Photo/video uses the system library/camera picker, copies the selected asset into app-owned document storage, persists that reference with the message, and renders it on home/history/calendar. The current mobile sync path does not yet synchronize photo/video end-to-end. Drawing remains a real-editor TODO; do not fake it by storing invented paths or placeholder media.

## Current implementation status

The React Native implementation currently has:

- Expo/RN/TypeScript foundation and Android development build setup.
- Local SQLite schema and repository, currently schema version 6.
- Relationship setup with partner name, own name, and optional together-since date.
- Partner active-message home screen.
- Local text and emoji message creation and active-message replacement.
- Local photo/video selection and camera capture with durable media storage.
- Immutable local history, including media messages.
- Month/date calendar browsing of historical messages, including media messages.
- Local-data reset from settings, including cleanup of owned media files.
- Domain use-case boundary used by the app screens.
- Explicit legacy database migrations and integrity validation through current schema v6.
- Durable sync state with sender sequence, pull cursor, outbox retry state, inbox receipts, and blocked terminal state.
- Typed cloud protocol client for authentication, pairing, synchronization, and media endpoints.
- Hardened sync engine with ordered bounded batches, post-commit ACK, sender/participant validation, and explicit handling for expected undecryptable inbound messages.
- Node domain/use-case tests and a native disposable-database SQLite/repository integration harness.

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

The five-emoji sequence is the user-facing mechanism, not a security credential. The real invitation token uses high-entropy server-side protocol machinery with expiry, bounded confirmation attempts, and one-time consumption. Pairing state should remain behind an abstraction so screens are not coupled directly to HTTP.

The product now has the pairing and sync plumbing wired together, but do not claim the online milestone is complete until real two-device acceptance/exchange has been validated.

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

## Cloud backend

Current direction: Cloudflare Workers + D1 for relationship/metadata/mailbox state + R2 for temporary media, unless implementation research gives a strong reason to change it.

The current Worker implementation is on `cloud/research` and already covers the core transport foundation:

- device-bound authentication;
- two-person relationship/pairing state;
- directional push/pull/ACK mailbox semantics;
- durable message receipts;
- bounded media reservation/upload/completion and R2 lifecycle;
- cleanup and finite retention;
- concurrency/idempotency hardening.

The Worker stores ciphertext and envelope metadata; it is not the permanent history store. The current retention contract is 14 days for mailbox messages and 30 days for durable delivery receipts. Local outbound synchronization has a separate 30-day terminal retention window.

The mobile branch now has persistent pairing credentials, an application-owned encrypted SyncEngine runtime, and foreground synchronization. Background scheduling and end-to-end media synchronization remain separate work.

## UI direction

The final UI should feel cute, personal, playful, slightly wonky and handmade, based on the Rucola Figma/reference assets. The owner will handle the detailed visual pass later.

For current development:

- use plain React Native controls;
- keep screens usable and testable;
- avoid unnecessary design-system work;
- do not turn the app into a generic Material showcase.

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
- synchronization ordering, durable acknowledgement, and ciphertext reuse across retries;
- dropped/undecryptable inbound handling;
- 30-day outbound retention/terminal deletion;
- the three-day Home rule once it is represented in testable application/domain logic.

Current validation includes Node domain/use-case tests and a native SQLite/repository integration runner using disposable databases. Keep the native suite separate from the Node suite; it exercises real Expo SQLite behavior and must not touch the normal `rucola.db`.

Relevant local commands:

```bash
npm ci
npm run typecheck
npm run test:domain
npx expo prebuild
npm run android
```

Cloud Worker validation lives separately under `cloud/worker` with its own `npm ci`, typecheck, and Vitest suite.

If native/build validation cannot be performed by an agent, state that explicitly. Do not fabricate results.

## Git workflow

- `main` is the stable integration branch.
- Work on a focused `feature/*`, `fix/*`, `test/*`, `chore/*`, or research branch created from `main`; never implement directly on `main`.
- Keep commits small and understandable.
- Do not commit secrets, generated build output, IDE state, or machine-specific configuration.
- Review the final diff for stale files, duplicate implementations, unused code, and contradictory documentation.
- Update documentation when architecture or behavior changes.
