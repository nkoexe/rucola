# Rucola — Agent Instructions

## Mission

Rucola is a private mobile app for exactly two people in a long-distance relationship. It is **not** a conventional chat app. The core idea is **one thing waiting for you from the person you love**.

Treat this as a real product codebase, but prefer simple, understandable solutions over enterprise ceremony.

## Current workstreams

Rucola is being developed in two parallel workstreams:

- `migration/react-native` — mobile application migration and client behavior;
- `cloud/research` — synchronization backend and cloud protocol research/implementation.

Keep the workstreams loosely coupled. The cloud must not become a prerequisite for the local application to function.

## Current stack and workflow

### Mobile

- Expo + React Native + TypeScript.
- Android is the primary target.
- Use Expo development builds / `expo prebuild`; do not design around Expo Go.
- Local persistence uses `expo-sqlite`.
- Local photo/video files use app-owned document storage.
- The local database is the permanent source of truth for history.
- The UI is deliberately barebones while functional behavior is stabilized.

### Cloud

- Cloudflare Worker for API/auth/synchronization orchestration.
- D1 for relationship, device, invitation, mailbox, receipt and media metadata.
- R2 for temporary cloud media; integration is still being implemented.
- Cloud payloads are opaque/encrypted; server code must not require plaintext application content.

## Before changing code

1. Read `docs/PRODUCT.md` and `docs/ARCHITECTURE.md`.
2. For cloud work, also read `docs/CLOUD_ARCHITECTURE.md`, `docs/CLOUD_HARDENING.md`, and `docs/MEDIA_LIFECYCLE.md`.
3. Inspect the existing implementation and dependencies before introducing patterns or packages.
4. Preserve the product and synchronization invariants below.
5. Keep changes focused and reviewable. Clean up stale/duplicate code when it is clearly part of the area being changed.
6. Do not claim a build or test was run unless it was actually run.
7. After substantial changes, perform a code review/audit for edge cases before moving on.

## Architecture rules

Mobile dependency direction:

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
```

Future synchronization must sit behind the domain/repository boundary. Screens must not depend directly on HTTP.

Cloud dependency direction:

```text
mobile local source of truth
        ↕
      sync engine
        ↕
Cloudflare Worker
   ↙          ↘
 D1           R2
metadata   temporary media
```

The cloud is a temporary transport/mailbox, not permanent application storage.

## Product invariants

- One relationship per device/account, exactly two participants.
- At most one active message per participant.
- Sending a new message moves that participant's previous active message into immutable history.
- Messages are immutable: no editing, deleting, replies, threads, or reactions in MVP.
- History contains both participants' messages and is permanent local data.
- The phone is the permanent data store.
- The home screen focuses on the partner's current message.
- Do not implement fake `read`/`unread` semantics. Delivery/synchronization is not the same as seeing a message.
- Offline-first is fundamental.
- Message ordering must survive offline bursts: A, B, C must all be preserved even though C is current.

## Cloud invariants

These are protocol rules, not implementation suggestions:

- Local SQLite remains the durable source of truth.
- D1 stores synchronization state, not permanent message history.
- Mailbox rows are temporary.
- A successful push must be retry-safe even if the response is lost.
- `message_id` + immutable payload identifies an accepted message.
- A durable receipt preserves the original server sequence after mailbox deletion.
- Sender sequence conflicts must remain bound to the authenticated sender device.
- Server sequence allocation and mailbox acceptance are atomic.
- A media-backed message must atomically attach a valid `READY` upload.
- `PHOTO_VIDEO` may reference only `PHOTO` or `VIDEO` media; other message types cannot reference media.
- Pull is non-destructive.
- ACK is the recipient durability boundary.
- A recipient must durably persist both a message and its referenced media before ACKing through that message.
- Pulling or ACKing must not directly delete R2 media.
- Relationship termination must prevent further normal pull/ACK behavior.
- Expired mailbox rows may create cursor gaps; cursors are high-water marks, not row counts.
- Cloud code must never require plaintext message content.
- Cleanup must be retry-safe and must not outrun sender retry guarantees.

See `docs/CLOUD_ARCHITECTURE.md` for the protocol and `docs/CLOUD_HARDENING.md` for the rationale behind the hardening work.

## Message types

- `TEXT`: content required.
- `EMOJI`: the emoji itself is the message.
- `PHOTO_VIDEO`: optional text; media-only is valid. Video is first-class.
- `DRAWING`: optional text; drawing-only is valid.

Drawing remains a real-editor TODO; do not fake it by storing invented paths or placeholder media.

## Pairing

Real two-device pairing requires the remote service and must not be faked as local-only communication.

The backend pairing flow uses a cryptographically random invitation token, a short confirmation code, expiry, bounded attempts/lockout and one-time invitation consumption. The human-facing code is not a security credential.

## Media

Local media and cloud media are separate lifecycles.

Local media is copied into app-owned storage before local message persistence. Cloud media uses the D1 lifecycle `PENDING → READY → ATTACHED`, with `ABANDONED` as the cleanup state.

Read `docs/MEDIA_LIFECYCLE.md` before implementing cloud media.

Do not implement destructive media cleanup until the sender retry/receipt retention contract is finalized.

## Settings / relationship lifecycle

`Clear local data` is a destructive local reset and may remove the local relationship, messages, and owned media from this device.

This is **not** the same as eventual unpairing. Unpairing must preserve local history and make the app read-only.

## Testing and validation

Tests are required for important domain/repository/backend behavior.

For cloud changes, test at least:

- authentication/authorization boundaries;
- idempotent push retries;
- sender sequence conflicts;
- server sequence invariants;
- media ownership/state/expiry;
- mailbox pull ordering and cursor gaps;
- ACK idempotency and concurrency;
- relationship termination;
- crash/retry lifecycle transitions.

If native/build validation cannot be performed by an agent, state that explicitly. Do not fabricate results.

## Git workflow

- Work on `migration/react-native`, `cloud/research`, or a focused feature/chore branch, never `main`.
- Keep commits small and understandable.
- Do not commit secrets, generated build output, IDE state, or machine-specific configuration.
- Review the final diff for stale files, duplicate implementations, unused code, and contradictory documentation.
- Update documentation whenever architecture or externally observable behavior changes.
