# Rucola — Architecture Notes

These notes describe the product's overall architecture and the boundary between the mobile application and the synchronization backend. They intentionally stay high-level. The detailed cloud protocol lives in `docs/CLOUD_ARCHITECTURE.md`.

## 1. Product model

Rucola is a private mobile mailbox for exactly two people. It is not a conventional chat archive.

The core rule is:

> The phone owns the permanent history. The cloud temporarily moves data between phones.

```text
             temporary cloud backend
          pairing / sync / mailbox / media
                       ↕
   ┌──────────────────────────┐
   │        Phone A           │
   │ React Native presentation│
   │ domain use cases         │
   │ local SQLite + media     │
   └──────────────────────────┘
                       ↕
   ┌──────────────────────────┐
   │        Phone B           │
   │ React Native presentation│
   │ domain use cases         │
   │ local SQLite + media     │
   └──────────────────────────┘
```

## 2. Mobile application architecture

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
expo-sqlite
```

Screens must not depend directly on SQLite or HTTP. Domain code must not depend on React Native. Repository interfaces describe capabilities rather than transport details.

The current mobile implementation remains usable without the backend.

## 3. Local data is authoritative

Historical messages persisted on a device are permanent application data unless a future explicit export/deletion feature removes them.

A backend outage must not make existing local history disappear or become inaccessible.

The cloud is not a second history database. Its mailbox and media objects are temporary synchronization artifacts.

## 4. Relationship and message model

The current prototype has one fixed local relationship ID because there is one relationship per installation. This is an implementation simplification, not a requirement that the cloud use the same identifier.

Each participant can have at most one active message. The active slot identifies the current message; messages themselves remain immutable history after replacement.

Messages contain:

- stable ID;
- relationship ID;
- participant;
- message type;
- body;
- creation timestamp;
- deterministic order information;
- optional local media reference;
- synchronization state.

## 5. Message replacement

Creating a message is transactional:

1. determine the next relationship-local order index;
2. persist the new message;
3. replace the participant's active slot;
4. commit.

The previous message is never deleted merely because it stopped being active.

The same semantic must hold when synchronization later delivers several messages while a recipient was offline.

## 6. Offline synchronization model

Example:

```text
A sends A
A sends B
A sends C

Recipient is offline.

Cloud temporarily queues A, B, C.

Recipient persists A, B, C locally in order.

Local result:
  A = history
  B = history
  C = active
```

The server must not collapse A/B/C to only C because the recipient needs complete history.

Synchronization state and read/seen state remain separate. MVP has no read receipts.

## 7. Cloud boundary

The cloud consists of a Cloudflare Worker, D1 metadata/state and temporary R2 media. The Worker authenticates devices, handles pairing and coordinates synchronization. D1 stores relationships, devices, invitations, mailbox rows, durable message receipts and media metadata. R2 stores temporary media objects.

The cloud protocol is specified in `docs/CLOUD_ARCHITECTURE.md`.

The hardening rationale and audit status are in `docs/CLOUD_HARDENING.md`.

The media-specific lifecycle is in `docs/MEDIA_LIFECYCLE.md`.

## 8. Media

Local photo/video files are copied into app-owned storage before local message persistence. The local message keeps a durable local reference.

Cloud media is a separate synchronization concern. A cloud media upload progresses through D1 lifecycle states and is attached atomically to an accepted message. The receiving client must persist the media locally before ACKing the corresponding mailbox sequence.

Pulling or ACKing a cloud mailbox row is not itself permission to delete the media object.

## 9. Pairing/security direction

Fresh installations eventually receive anonymous device identities. There is no normal account-registration UX.

Pairing uses:

- a cryptographically random invitation token;
- a short human-facing confirmation code as a usability aid;
- invitation expiry;
- bounded failed attempts/lockout;
- one-time invitation consumption.

The human-facing code is not a standalone security credential.

Real two-device pairing must occur through the backend; it must not be simulated as local communication.

## 10. Widgets and notifications

Widgets should read local state and never require a network request just to render the current partner message.

Push notifications should generally prompt synchronization rather than carry message content. Background execution is platform-dependent and must not be treated as guaranteed immediate execution.

## 11. Unpairing

Unpairing is different from clearing local data.

The eventual unpair behavior is:

```text
relationship ended
      ↓
local history remains
      ↓
app becomes read-only
```

Export/deletion is a separate future feature. `Clear local data` is an explicit destructive local reset and must not be presented as unpairing.

## 12. Core invariants

Tests should protect at least:

1. one relationship per local installation;
2. at most one active message per participant at the database level;
3. sending a new message archives the previous active message;
4. history is not destroyed by replacement;
5. both participants' messages coexist in local history;
6. message order is deterministic;
7. persistence survives process/app restarts;
8. invalid message input is rejected before persistence;
9. media messages remain valid and durable when their local implementation is present;
10. malformed legacy data cannot cause a partial local migration;
11. cloud acceptance preserves message identity across retries;
12. cloud ACK happens only after recipient-side durable persistence;
13. cloud media attachment is atomic with message acceptance.

## 13. Technology rule

Use the current Expo/React Native stack and stable Expo-compatible packages. Do not add dependencies merely to make a small feature look architectural.

The UI remains deliberately separate from backend correctness work. Functional behavior, local correctness, synchronization semantics and clean boundaries take priority until the feature set is stable.
