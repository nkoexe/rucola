# Rucola React Native Migration

## Goal

Replace the Kotlin/Jetpack Compose prototype with an Expo + React Native + TypeScript application while preserving Rucola's product invariants and local/offline-first architecture.

The Kotlin implementation is a behavioral reference, not a code-conversion target.

## Current stack

- Expo + React Native + TypeScript
- Android development build / prebuild workflow
- `expo-sqlite` local persistence
- `expo-image-picker` + `expo-file-system` local media persistence
- `expo-video` local video playback
- Local SQLite is the source of truth for the prototype
- No backend/network dependency yet

## Completed migration phases

### Phase 1 — Foundation

- Expo + React Native + TypeScript scaffolded.
- Android native project available for development builds and future native features.
- Package configuration and TypeScript strictness established.
- Development build workflow used instead of Expo Go.

### Phase 2 — Local domain and persistence

- TypeScript domain model established.
- `RucolaRepository` interface established before persistence access.
- SQLite database contains relationships, messages, active-message slots, ordering, media references, and sync state.
- Message replacement is transactional.
- Stable local message IDs are generated with `expo-crypto`.
- Local persistence has no network dependency.

### Phase 3 — Functional local prototype

- Onboarding: partner nickname → own name → optional together-since date → home.
- Partner active-message home screen.
- Local text message creation.
- Local emoji message creation using a small barebones picker.
- Previous own active message is archived into immutable history when a new one is sent.
- History screen shows historical messages only.
- Calendar supports month navigation and date selection for historical messages.
- Settings can clear all local relationship/message data.
- UI screens use domain use cases rather than accessing the repository directly.
- Setup/date and persistence errors are surfaced instead of silently failing.
- Duplicate legacy domain model/use-case files on the migration branch were removed.

### Phase 4a — Local photo/video media

- Photo/video selection from the device library.
- Photo/video capture through the device camera.
- Picked media is copied into Rucola's durable app document storage before the message is persisted.
- Media-only messages are supported; an optional caption can be included.
- Active photo/video messages render on the home screen.
- Historical photo/video messages render in history and calendar views.
- Clearing local relationship data removes media files owned by the relationship.

## Deliberate current limitations

- Drawing is still a placeholder.
- There is no real two-device pairing yet.
- There is no backend, synchronization engine, push notification system, widget, or E2E encryption.
- The UI is intentionally barebones. Detailed Figma implementation is deferred until behavior is complete.
- The dependency lockfile still needs to be regenerated locally after adding the new Expo media packages.

Do not fake two-device communication. Pairing must become genuinely functional once a backend transport exists.

## Architecture

```text
React Native screens/components
        ↓
presentation state/hooks
        ↓
domain use cases + repository interfaces
        ↓
local persistence implementation
        ↓
SQLite + app document media

future:
sync engine → pairing/sync API
media store → local files + temporary remote mailbox
```

Screens should not depend directly on SQLite or HTTP. Domain code should remain platform-independent.

## Product invariants

- Exactly one relationship per local account/device.
- Exactly two participants.
- At most one active message per participant.
- Sending a new message archives the previous active message rather than deleting it.
- History is immutable local data.
- Messages have stable IDs and deterministic order metadata.
- Sync state is separate from read/seen state; no read receipts exist in MVP.
- The server, when introduced, is a temporary mailbox rather than the archive/source of truth.

## Pairing direction

Pairing is the next major architecture feature, but it cannot be honestly completed without a remote transport.

The target flow is:

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

The human-facing code is only a usability aid. The secure invitation token must have real entropy, expire after a limited period (target 24 hours), and become invalid immediately after successful pairing.

The implementation should introduce a pairing abstraction before wiring a backend so the UI does not become coupled to HTTP. Do not make the human-facing code the security credential.

## Next implementation phases

### Phase 4b — Drawing

Implement a real local drawing composer and persist its output as durable message media. Drawing should support a media-only message and an optional caption, just like photo/video messages.

### Phase 5 — Backend pairing and synchronization

After the local media/message behavior is stable:

- add anonymous device identity;
- implement secure invitation creation/acceptance;
- add shareable deep links and human-facing pairing codes;
- add backend synchronization behind repository/sync abstractions;
- preserve offline bursts and immutable local history;
- acknowledge server items only after durable local persistence.

### Later

- push/background synchronization;
- notifications;
- widgets reading local state;
- statistics/streaks;
- unpairing/read-only relationship state;
- E2E encryption using an established protocol/library;
- final Figma-driven UI pass.

## Validation

The GitHub integration can inspect and modify source, but cannot run the project's local npm/Expo/Android toolchain. After pulling the branch, run:

```bash
npm install
npm run typecheck
npx expo prebuild
npm run android
```

The owner has already confirmed the Android development build works after the earlier JVM/memory issue was resolved. Any future dependency or native failure should be reported with its actual output rather than inferred.
