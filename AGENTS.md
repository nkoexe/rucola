# Rucola — Agent Instructions

## Mission

Rucola is a private mobile app for exactly two people in a long-distance relationship. It is **not** a chat app. The core idea is **one thing waiting for you from the person you love**.

Treat this as a real product codebase, but prefer simple, understandable solutions over enterprise ceremony.

## Current stack and workflow

- Expo + React Native + TypeScript.
- Android is the primary target.
- Use Expo development builds / `expo prebuild`; do not design around Expo Go.
- Local persistence uses `expo-sqlite`.
- The local database is the source of truth in the current prototype.
- Work on `migration/react-native` until the migration is complete; never implement directly on `main`.
- The owner is intentionally keeping the UI barebones for now. Prioritize complete behavior, correct state, persistence, and architecture over visual polish.
- Figma/reference assets are for the later UI pass unless a task explicitly requires them.

## Before changing code

1. Read `docs/PRODUCT.md` and `docs/ARCHITECTURE.md`.
2. Inspect the existing implementation and dependencies before introducing patterns or packages.
3. Preserve the product invariants below.
4. Keep changes focused and reviewable. Clean up stale/duplicate code when it is clearly part of the area being changed.
5. Do not claim a build or test was run unless it was actually run.

## Architecture

Use this dependency direction:

```text
React Native screens/components
        ↓
presentation state/hooks
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

Keep synchronization state in the domain/data model so a future backend can be introduced without rewriting the UI. Networking is not currently implemented.

## Product invariants

- One relationship per device/account, exactly two participants.
- Each participant has exactly one active message.
- Sending a new message moves that participant's previous active message into immutable history.
- Messages are immutable: no editing, deleting, replies, threads, or reactions in MVP.
- History contains both participants' messages and is permanent local data.
- The phone is the permanent data store; a future server is only a temporary mailbox.
- The home screen focuses on the partner's current message.
- Do not implement fake `read`/`unread` semantics. Delivery/synchronization is not the same as the user seeing a message.
- Offline-first is fundamental. UI consumes local repositories/state.
- Message ordering must survive offline bursts: A, B, C must all be preserved even though C is the current active message.

## Message types

- `TEXT`: content required.
- `EMOJI`: the emoji itself is the message.
- `PHOTO_VIDEO`: optional text; media-only is valid. Video is first-class.
- `DRAWING`: optional text; drawing-only is valid.

The current UI exposes text composition and placeholder photo/video/drawing controls. Do not fake media persistence by storing invented paths or pretending a picker/editor exists.

## Current implementation status

The React Native branch currently has:

- Expo/RN/TypeScript foundation and Android development build setup.
- Local SQLite schema and repository.
- Relationship setup with partner name, own name, and optional together-since date.
- Partner active-message home screen.
- Local text message creation and active-message replacement.
- Immutable local history.
- Month/date calendar browsing of historical messages.
- Local-data reset from settings.
- Domain use-case boundary used by the app screens.

The UI is deliberately barebones. Do not spend the next implementation phase on Figma fidelity.

## Pairing

Real two-device pairing requires a remote service and must **not** be faked as local-only communication.

The intended eventual flow is:

```text
unpaired
  ↓
create invitation
  ↓
share deep link / human-facing code
  ↓
partner enters invitation
  ↓
server validates secure token
  ↓
paired relationship
```

The human-facing code is not a security credential. The real invitation token needs cryptographic entropy, expiry (target 24h), and one-time use. Pairing state should be designed behind an abstraction so the future backend can be added without coupling screens to HTTP.

Until a backend exists, do not claim that two separate devices can pair or exchange messages.

## Onboarding

Current local prototype onboarding is:

1. `who are they?`
2. `who are you?`
3. together-since date or `shh... not yet`
4. home

Do not add an avatar/tutorial step unless explicitly requested. Partner avatar support can be added later.

## History and calendar

- History is immutable and local.
- Active messages are not history.
- History includes both participants.
- Calendar marks days containing historical messages and opens that day's messages.
- Primary swipe navigation can be added later; a basic navigation control is acceptable while functionality is prioritized.

## Settings / relationship lifecycle

`Clear local data` is a destructive local reset and may remove the local relationship and messages from this device.

This is **not** the same as the eventual unpair flow. Eventual unpairing must preserve local history and make the app read-only. Do not silently implement one as the other.

## Future backend direction

Likely direction: Cloudflare Workers + D1 for metadata/state + R2 for temporary media, unless implementation research gives a strong reason to change it.

The future server must:

- queue unsynchronized messages in order;
- preserve replaced messages until the recipient durably persists and acknowledges them;
- treat local persistence as the archive/source of truth;
- support media with the same durability/acknowledgement rule;
- never require the UI to depend directly on the network.

Push/background synchronization and widgets come later and must respect platform execution limits.

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
- one-active-message-per-participant invariant.

Relevant local commands:

```bash
npm install
npm run typecheck
npx expo prebuild
npm run android
```

If native/build validation cannot be performed by an agent, state that explicitly. Do not fabricate results.

## Git workflow

- Work on `migration/react-native` or a focused feature/chore branch, never `main`.
- Keep commits small and understandable.
- Do not commit secrets, generated build output, IDE state, or machine-specific configuration.
- Review the final diff for stale files, duplicate implementations, unused code, and contradictory documentation.
- Update documentation when architecture or behavior changes.
