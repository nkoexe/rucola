# Rucola — Architecture Notes

This document captures architectural intent, not a rigid implementation prescription. Agents may choose better concrete technologies when justified, but must preserve the product invariants.

## 1. High-level model

```text
Cloudflare (future)
  Worker API / pairing / sync
  D1 metadata + relationship state
  R2 temporary media
          ↕
   ┌───────────────┐
   │   Phone A     │
   │ local SQLite  │
   │ history/media │
   │ widget/cache  │
   └───────────────┘
          ↕
   ┌───────────────┐
   │   Phone B     │
   │ local SQLite  │
   │ history/media │
   │ widget/cache  │
   └───────────────┘
```

The server is a mailbox, not a database-backed cloud drive. Once a recipient has durably persisted an item, the server should be able to remove its temporary copy.

## 2. Local application architecture

Preferred conceptual separation:

```text
UI / Compose
    ↓
View models / presentation state
    ↓
Domain use cases + repository interfaces
    ↓
Local persistence implementation
    ↓
SQLite / Room

Future:
Sync engine → sync API implementation
Media store → local files + future R2 mailbox implementation
```

The exact package/module structure is left to the implementation agent. Avoid creating many Gradle modules simply to look architectural.

The UI should depend on domain-facing state/repositories rather than directly querying Room or making HTTP requests.

## 3. Local data is authoritative for history

Every historical message that has been synchronized to a device is permanent local data unless the user explicitly deletes/export-clears it in a future feature.

Do not design local history as a cache of the server.

A server outage must not make existing history disappear or become inaccessible.

## 4. Message state

Conceptually each participant has:

- zero or one active message
- zero or more immutable historical messages

The local model should make it difficult or impossible to accidentally create two active messages for one participant.

A message needs enough stable identity/metadata to support eventual synchronization and ordering. Avoid relying on timestamps alone for identity or ordering.

A useful future-oriented concept is a stable message ID generated on the originating device, plus immutable creation/order metadata. Concrete schema choices are implementation details.

## 5. Message replacement

When a participant creates a new message locally:

1. Persist the new message.
2. Move the previous active message for that participant to history.
3. Make the new message active.
4. Preserve immutable history.

The operation should be transactional from the perspective of local persistence.

The same semantics must remain valid when synchronization delivers several messages at once.

## 6. Offline synchronization

Example:

```text
A sends A
A sends B
A sends C

Recipient is offline.

Server mailbox eventually contains A, B, C.

Recipient synchronizes:
  persist A
  persist B
  persist C
  acknowledge durable persistence

Local result:
  A = history
  B = history
  C = active

Server can then remove A/B/C.
```

The server must not collapse A/B/C into only C because the recipient needs the complete history.

The server must not delete an item merely because delivery was attempted. Acknowledgement must mean that the recipient has durably persisted the item locally.

There is deliberately no read/seen state in MVP.

## 7. Sync state vs read state

Keep these concepts separate:

- **pending/queued**: item needs synchronization
- **synchronized/durably persisted**: recipient has confirmed local persistence
- **seen/read**: user has actually viewed it

Only the first two are relevant to the initial synchronization architecture. Do not invent `read=true` as a shortcut for synchronization acknowledgement.

## 8. Media lifecycle

Photo/video and drawing data are eventually handled similarly to message data.

The server stores temporary media only while it needs to deliver it. The recipient downloads and durably stores the media locally, then acknowledges persistence. The server can then remove the temporary object.

The first local prototype may represent media with placeholders, but the domain model should not make media impossible later.

## 9. Future backend

Current preferred direction:

- Cloudflare Workers — API, pairing, authentication/authorization, synchronization orchestration
- D1 — small metadata/relationship state
- R2 — temporary media mailbox

This is a direction, not an excuse to implement backend code before the product's local foundation is sound.

## 10. Pairing/security direction

Fresh installs receive anonymous device identities.

Future pairing should provide:

- secure invitation token with sufficient entropy
- cute human-readable/visual pairing code as a usability aid
- shareable deep link
- invitation expiry (target 24h)
- immediate invalidation after successful pairing

Do not use the cute code itself as an authentication secret.

MVP does not include E2E encryption. When added, use an established protocol/library rather than custom cryptography.

## 11. Widgets

Widgets should read local state/cache.

They must not require a network request just to render the current partner message.

Background synchronization can update the local database/cache and then trigger the widget refresh.

Platform scheduling can delay background work, so the product should not depend on guaranteed instant widget updates.

## 12. Notifications

Push notifications are a future sync feature.

A push should generally indicate that the partner left something rather than carry the full message content. The app then synchronizes the actual item and persists it locally.

## 13. Unpairing

Unpairing is a future server-backed feature. The intended invariant is:

```text
relationship ended/unpaired
        ↓
local history remains
        ↓
app becomes read-only
```

Data export/deletion and recovery are separate future features.

## 14. Core invariants for tests

Tests should protect at least:

1. exactly one relationship contains exactly two participants
2. a participant has at most one active message
3. creating a new message archives the previous active message
4. history is immutable
5. both participants' histories can coexist locally
6. messages retain deterministic ordering
7. local persistence survives process/app restarts
8. synchronization acknowledgement is conceptually distinct from read/seen state
9. replacing an active message never destroys the previous message

## 15. Technology decision rule

Choose boring, stable, well-supported Android technologies unless there is a concrete reason not to.

Android is primary. Kotlin + Compose + Room/SQLite is the default direction.

Kotlin Multiplatform is permitted if the implementation agent can show a concrete benefit for the eventual iOS target. Do not add it solely because it might be useful someday.

Avoid heavyweight frameworks and abstractions that do not earn their complexity.
