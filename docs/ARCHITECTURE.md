# Rucola — Architecture Notes

These notes describe the current React Native implementation and the constraints future work must preserve. They are intentionally lightweight: this is a small app, not a reason to create enterprise infrastructure.

## 1. High-level model

```text
             future backend
       pairing / sync / mailbox
                  ↕
   ┌──────────────────────────┐
   │        Phone A           │
   │ React Native presentation│
   │ domain use cases         │
   │ repository               │
   │ local SQLite + media     │
   └──────────────────────────┘
                  ↕
   ┌──────────────────────────┐
   │        Phone B           │
   │ React Native presentation│
   │ domain use cases         │
   │ repository               │
   │ local SQLite + media     │
   └──────────────────────────┘
```

The server is a temporary mailbox, not a cloud archive. Once a recipient has durably persisted an item locally and acknowledged it, the server may remove its temporary copy.

## 2. Current local application architecture

```text
React Native screens/components
        ↓
presentation state/hooks
        ↓
domain use cases
        ↓
RucolaRepository interface
        ↓
SQLiteRucolaRepository
        ↓
expo-sqlite
```

The current screens use domain use cases for relationship loading, setup, message creation, history, calendar data, and local reset. Domain code does not import React Native or SQLite.

`SQLiteRucolaRepository` is the local implementation and can later be accompanied by synchronization without forcing the UI to call a network API directly.

## 3. Local data is authoritative for history

Historical messages persisted on a device are permanent application data unless a future explicit export/deletion feature removes them.

A backend outage must not make existing local history disappear or become inaccessible.

## 4. Relationship and message model

The current prototype has one fixed local relationship ID (`the-one`) because there is only one relationship per installation. This is an implementation simplification, not a promise that a server should use that identifier.

Each participant is intended to have exactly one active message and zero or more immutable historical messages. The application lifecycle establishes the active slots; SQLite enforces that a participant cannot have more than one active slot and that each slot points to a message belonging to the same relationship and participant.

Messages contain:

- stable ID;
- relationship ID;
- participant;
- message type;
- body;
- creation timestamp;
- deterministic order index;
- optional media reference;
- synchronization state.

Active state is **derived**, not stored on the message row. The `active_message_slots` table is the source of truth for which message is active for each participant.

## 5. Message replacement

Creating a message is transactional:

1. determine the next relationship-local order index;
2. persist the new message;
3. replace the participant's active slot with the new message;
4. commit the transaction.

The previous message is never deleted, so it becomes immutable history automatically because it is no longer referenced by the participant's active slot.

This same semantic must hold when synchronization later delivers several messages while a recipient was offline.

## 6. Offline synchronization model

Example:

```text
A sends A
A sends B
A sends C

Recipient is offline.

Server temporarily queues A, B, C.

Recipient persists A, B, C locally in order.

Local result:
  A = history
  B = history
  C = active

Only after durable persistence may the recipient acknowledge them.
```

The server must not collapse A/B/C to only C because the recipient needs complete history.

There is deliberately no read/seen state in MVP.

## 7. Sync state vs read state

These concepts remain separate:

- `PENDING`: local item still needs synchronization;
- `SYNCED`: synchronization has completed according to the eventual protocol;
- `FAILED`: synchronization needs retry/recovery;
- `LOCAL_ONLY`: item exists only locally so far;
- **seen/read**: not represented in the MVP.

Never use synchronization state as a disguised read receipt.

## 8. Media lifecycle

Photo/video and drawing messages use the same immutable message lifecycle as text and emoji.

The local model already has `mediaReference`, `PHOTO_VIDEO`, and `DRAWING` message types so media can be implemented without redesigning the message schema.

The current UI deliberately uses placeholders. Real media must be durably stored locally before it is treated as local message data.

## 9. Database migrations

SQLite uses `PRAGMA user_version` for schema versioning. The current schema is version 2.

Fresh databases are created directly at the latest schema. Existing version-0 databases that contain the original tables and version-1 databases both use the legacy schema and are migrated transactionally to version 2.

The migration validates legacy active-message slots before changing the schema. It rejects mismatched slots, missing messages, invalid active flags, duplicate active slots, and values that cannot be represented safely as integers. After migration, `PRAGMA foreign_key_check` is run and the database must report exactly the supported schema version.

A database newer than the application is rejected rather than downgraded. Migration failures are allowed to abort the transaction so the old database is not partially replaced.

## 10. Pairing/security direction

Fresh installations eventually receive anonymous device identities. There is no normal account-registration UX.

Pairing should use:

- a secure invitation token with real entropy;
- a short cute human-facing code as a usability aid;
- a shareable deep link;
- invitation expiry (target 24 hours);
- immediate invalidation after successful pairing.

The human-facing code is **not** a security credential.

Real two-device pairing must not be simulated as local communication. The UI can be prepared behind a pairing abstraction before the backend exists, but pairing is not considered complete until two installations can actually establish the relationship through a real transport.

## 11. Future backend

The current preferred direction is:

- Cloudflare Workers — API, pairing, synchronization orchestration;
- D1 — small relationship/metadata state;
- R2 — temporary media mailbox.

This remains future work. The local app must continue to function without the backend.

## 12. Widgets and notifications

Widgets should read local state and never require a network request just to render the current partner message.

Push notifications should generally prompt synchronization rather than carry message content. Background execution is platform-dependent and must not be treated as guaranteed immediate execution.

## 13. Unpairing

Unpairing is different from clearing local data.

The eventual unpair behavior is:

```text
relationship ended
      ↓
local history remains
      ↓
app becomes read-only
```

Export/deletion is a separate future feature. The current Settings `Clear local data` action is an explicit destructive local reset and must not be presented as unpairing.

## 14. Core invariants for tests

Tests should protect at least:

1. one relationship per local installation;
2. at most one active message per participant at the database level;
3. normal relationship lifecycle establishes one active message per participant;
4. creating a new message archives the previous active message;
5. history is not destroyed by replacement;
6. both participants' messages coexist in local history;
7. message order is deterministic;
8. persistence survives process/app restarts;
9. invalid message input is rejected before persistence;
10. media-only message types remain valid when their real media implementation is added;
11. version-1 legacy databases migrate to the current schema without losing data;
12. malformed legacy data causes migration to fail without a partial migration.

## 15. Technology rule

Use the current Expo/React Native stack and stable Expo-compatible packages. Do not add dependencies merely to make a small feature look architectural.

The owner is deliberately postponing detailed visual implementation. Functional behavior, local correctness, and clean boundaries take priority until the feature set is complete.
