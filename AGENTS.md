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
Expo Router / React Native screens
        ↓
application bootstrap + presentation state
        ↓
domain use cases
        ↓
repository interfaces
        ↓
SQLite persistence

future:
sync engine → temporary backend/mailbox
```

Screens must not depend directly on SQLite or HTTP. Domain code must not depend on React Native. Repository interfaces describe capabilities; the SQLite implementation is replaceable.

### Navigation rule

Use **Expo Router** for application navigation. The current hand-rolled `AppScreen` enum/callback navigation is transitional and must not be expanded with additional screens or navigation branches.

New routes belong under `src/app/` and should be thin routing boundaries that delegate to feature implementations under `src/screens/` where practical. Pairing/deep-link routes should fit the same routing model rather than introducing a second navigation mechanism.

The application bootstrap should have one clear owner for repository initialization, relationship loading, and shared refresh/invalidation state. Do not recreate global application lifecycle state independently inside individual screens.

Keep synchronization state in the domain/data model so a future backend can be introduced without rewriting the UI. Networking is not currently implemented.

## Product invariants

- One relationship per device, exactly two participants once paired.
- At most one active message per participant; the normal lifecycle gives the partner a seeded active message during setup and gives the user an active message when they first send one.
- Sending a new message moves that participant's previous active message into immutable history.
- Messages are immutable: no editing, deleting, replies, threads, or reactions in the initial product.
- History contains both participants' messages and is permanent local data.
- The phone is the permanent data store; a future server is only a temporary mailbox.
- The Home screen focuses on the partner's current message.
- After three days without a newer partner message, Home transitions to a gentle stale/waiting prompt; the old message remains in History.
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
- Local SQLite schema and repository.
- Relationship setup with partner name, own name, and optional together-since date.
- Partner active-message home screen.
- Local text and emoji message creation and active-message replacement.
- Local photo/video selection and camera capture with durable media storage.
- Immutable local history, including media messages.
- Month/date calendar browsing of historical messages, including media messages.
- Local-data reset from settings, including cleanup of owned media files.
- Domain use-case boundary used by the app screens.
- Explicit SQLite v0/v1 → v2 migration handling and integrity validation.
- Node domain/use-case tests and native SQLite/repository integration coverage.

The UI is deliberately barebones. Do not spend the current implementation phase on Figma fidelity.

## Pairing

Real two-device pairing requires a remote service and must **not** be faked as local-only communication.

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

The five-emoji sequence is the user-facing mechanism, not a security credential. The real invitation token needs cryptographic entropy, expiry (target 24h), and one-time use. Pairing state should be designed behind an abstraction so the future backend can be added without coupling screens to HTTP.

Until a backend exists, do not claim that two separate devices can pair or exchange messages.

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

## Future backend direction

Likely direction: Cloudflare Workers + D1 for metadata/state + R2 for temporary media, unless implementation research gives a strong reason to change it.

The future server must:

- queue unsynchronized messages in order;
- preserve replaced messages until the recipient durably persists and acknowledges them;
- treat local persistence as the archive/source of truth;
- support media with the same durability/acknowledgement rule;
- never require the UI to depend directly on the network.

Backend work should progress alongside local product work after the application structure is stable. The first major product checkpoint is a rough but genuinely online two-person prototype.

Push/background synchronization and the Android widget come later and must respect platform execution limits.

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
- synchronization ordering and durable acknowledgement once the backend exists;
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

If native/build validation cannot be performed by an agent, state that explicitly. Do not fabricate results.

## Git workflow

- `main` is the stable integration branch.
- Work on a focused `feature/*`, `fix/*`, `test/*`, `chore/*`, or research branch created from `main`; never implement directly on `main`.
- Keep commits small and understandable.
- Do not commit secrets, generated build output, IDE state, or machine-specific configuration.
- Review the final diff for stale files, duplicate implementations, unused code, and contradictory documentation.
- Update documentation when architecture or behavior changes.
