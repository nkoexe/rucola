# Rucola — Architecture Notes

These notes describe the current React Native implementation and the constraints future work must preserve. They are intentionally lightweight: this is a small app, not a reason to create enterprise infrastructure.

The product-level source of truth is `docs/PRODUCT_SPEC.md`; the phased implementation plan is `docs/DEVELOPMENT_ROADMAP.md`.

## 1. High-level model

```text
                  cloud backend
          pairing / sync / mailbox
                    ↕
   ┌──────────────────────────┐
   │        Phone A           │
   │ Expo Router / RN         │
   │ application state        │
   │ domain use cases         │
   │ repository + sync engine │
   │ local SQLite + media     │
   └──────────────────────────┘
                    ↕
   ┌──────────────────────────┐
   │        Phone B           │
   │ Expo Router / RN         │
   │ application state        │
   │ domain use cases         │
   │ repository + sync engine │
   │ local SQLite + media     │
   └──────────────────────────┘
```

The server is a temporary mailbox, not a cloud archive. Once a recipient has durably persisted an item locally and acknowledged it, the server may remove its temporary copy.

The cloud Worker is implemented on the separate `cloud/research` branch. The mobile client transport and local sync state are now merged into `main`, but the app does not yet run an integrated online lifecycle.

## 2. Current local application architecture

```text
React Native screens
        ↓
current presentation/application state
        ↓
domain use cases
        ↓
RucolaRepository interface
        ↓
SQLiteRucolaRepository
        ↓
expo-sqlite

CloudClient ← SyncEngine → SQLiteSyncStateStore
```

The current screens use domain use cases for relationship loading, setup, message creation, history, calendar data, and local reset. Domain code does not import React Native or SQLite.

The application still contains hand-rolled screen state/navigation and is scheduled for an Expo Router/application-state cleanup before more presentation complexity is added.

`SQLiteRucolaRepository` is the local implementation. `CloudClient` isolates HTTP transport, while `SyncEngine` coordinates ordered outgoing sync and inbound pull/commit/ACK using durable SQLite sync state. The UI is not intended to call HTTP directly.

## 3. Local data is authoritative for history

Historical messages persisted on a device are permanent application data unless a future explicit export/deletion feature removes them.

A backend outage must not make existing local history disappear or become inaccessible.

## 4. Relationship and message model

The current prototype has one fixed local relationship ID (`the-one`) because there is only one relationship per installation. This is an implementation simplification, not a promise that a server should use that identifier.

Each participant is intended to have exactly one active message once that participant has a message. SQLite enforces that a participant cannot have more than one active slot and that each slot points to a message belonging to the same relationship and participant.

Messages contain:

- stable ID;
- relationship ID;
- participant;
- message type;
- body;
- creation timestamp;
- deterministic local order index;
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

## 6. Three-day Home state

The three-day stale/waiting rule is a product requirement but is **not yet implemented in the current application**. Once implemented, it belongs in testable application/domain state rather than arbitrary screen decoration.

Target behavior:

- a recent partner message is shown normally;
- after three days without a newer partner message, Home transitions to a gentle stale/waiting prompt encouraging the user to send something;
- the old message remains in immutable History.

## 7. Offline synchronization model

The mobile sync foundation now has durable state for sender sequence, pull cursor, outbox and inbound receipts. `SyncEngine` performs:

```text
push due local outbox
        ↓
pull after durable cursor
        ↓
validate/decrypt inbound payloads
        ↓
SQLite transaction
  ├─ insert/idempotently apply inbound message
  ├─ update partner active slot
  └─ advance durable pull cursor
        ↓
COMMIT
        ↓
ACK server high-water mark
```

Outgoing messages retain stable IDs and durable sender sequences across retries. Retryable failures use persisted backoff; permanently blocked items are not silently requeued. The engine coalesces concurrent runs so multiple triggers do not execute overlapping sync passes.

The current mobile engine intentionally blocks media synchronization until the end-to-end media path exists. The encryption codec is an abstraction only; there is no real E2E implementation yet.

The server implementation is being hardened independently. Current cloud work includes directional mailbox ownership fixes in open PR #15; that change is important because a sender must not pull or ACK its own mailbox copies as if they were partner deliveries.

## 8. Sync state vs read state

These concepts remain separate:

- `PENDING`: local item still needs synchronization;
- `SYNCED`: synchronization has completed according to the current client path;
- `FAILED`: synchronization needs retry/recovery;
- `LOCAL_ONLY`: item exists only locally so far;
- `blocked` outbox state: a durable protocol/media failure prevents automatic retry;
- **seen/read**: not represented in the MVP.

Never use synchronization state as a disguised read receipt.

## 9. Media lifecycle

Photo/video messages use the real device picker/camera path. Selected or captured media is copied into an app-owned document `media/` directory before the message is persisted. Message history stores the durable local URI and can render images or videos from that URI.

The local cloud client has media reservation/upload/completion transport, but `SyncEngine` currently treats media synchronization as blocked. Cloud-side media lifecycle is implemented separately on `cloud/research` and still requires final integration/production hardening.

Drawing remains a declared message type but is intentionally not implemented yet.

If a media message fails to persist after the file has been copied, the newly copied file is removed. Clearing local data removes database rows first and then attempts to remove their app-owned media files; missing or already-unreadable files do not prevent the database reset from completing.

Media deletion only accepts direct children of the app-owned media directory, preventing a malformed stored URI from escaping that directory through path traversal.

## 10. Database migrations

SQLite currently uses `PRAGMA user_version` with schema version **5**. Fresh databases are created directly at v5. Existing legacy databases are migrated through the supported v0/v1 → v2 path and v2 → v3 → v4 → v5 sync-schema migrations.

Current v5 adds durable sync state, inbox records, and a `blocked` outbox state. The database verification checks the required six core/sync tables, the blocked outbox column, foreign-key integrity, and the final supported version.

A database newer than the application is rejected rather than downgraded. Migration failures are allowed to abort the transaction so the old database is not partially replaced.

## 11. Pairing/security direction

Fresh installations eventually receive anonymous device identities. There is no normal account-registration or login UX.

The **user-facing pairing mechanism is exactly five emojis**. Technical pairing credentials must remain implementation details.

The mobile `CloudClient` now exposes bootstrap/create/accept pairing transport, but the application has not yet integrated those operations into onboarding. Real two-device pairing is therefore not complete.

The cloud protocol uses secure invitation credentials behind the human-facing five-emoji flow, with expiry and bounded confirmation attempts. Device authentication and future encryption identity remain separate.

## 12. Future backend / current cloud implementation

The production direction remains:

- Cloudflare Workers — API, pairing, synchronization orchestration;
- D1 — relationship/metadata and temporary mailbox/receipts;
- R2 — temporary media storage.

Substantial Worker implementation exists on `cloud/research`, including pairing, authenticated push/pull/ACK, durable message receipts, media reservation/upload/completion, cleanup and database invariants. PR #15 is an open hardening change that corrects mailbox directionality for two-device behavior.

The cloud branch is not yet the stable mobile integration. Do not describe the overall system as an end-to-end online prototype until pairing, credential persistence, sync lifecycle, and real two-device message exchange are integrated and tested.

## 13. Widgets and notifications

The long-term Android Home widget is an extension of the same Home state, not a separate message model.

Widgets should read local state and never require a network request just to render the current partner message.

Push notifications are complementary. They should generally prompt synchronization/re-entry rather than become the primary message-reading experience or carry sensitive message content.

## 14. Unpairing

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

## 15. Core invariants for tests

Tests should protect at least:

1. one relationship per local installation;
2. exactly two participants once paired;
3. at most one active message per participant at the database level;
4. normal relationship lifecycle establishes the partner active message and creates the own active message when the user first sends one;
5. creating a new message archives the previous active message;
6. history is not destroyed by replacement;
7. both participants' messages coexist in local history;
8. message order is deterministic;
9. persistence survives process/app restarts;
10. invalid message input is rejected before persistence;
11. photo/video media-only messages remain valid with durable app-owned media;
12. drawing remains intentionally unimplemented until a real editor exists;
13. supported legacy databases migrate to v5 without losing data;
14. malformed legacy data causes migration to fail without a partial migration;
15. synchronization preserves bursts while a recipient is offline;
16. synchronization acknowledgment occurs only after durable local persistence;
17. inbound cursor cannot regress or advance inconsistently;
18. permanently blocked outbox items do not resurrect automatically;
19. the three-day stale Home state does not delete or alter history once implemented;
20. mailbox directionality prevents a sender from treating its own messages as partner deliveries.

## 16. Technology rule

Use the current Expo/React Native stack and stable Expo-compatible packages. Do not add dependencies merely to make a small feature look architectural.

The owner is deliberately postponing detailed visual implementation. Functional behavior, local correctness, coherent navigation/interaction order, clean sync boundaries, and reliable two-device behavior take priority until the feature set is complete.

The product is Android-first. Do not introduce platform abstractions merely for theoretical iOS support unless they simplify the current architecture without compromising Android delivery.
