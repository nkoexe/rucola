# Rucola — Architecture Notes

These notes describe the current React Native implementation and the constraints future work must preserve. They are intentionally lightweight: this is a small app, not a reason to create enterprise infrastructure.

The product-level source of truth is `docs/PRODUCT_SPEC.md`; the phased implementation plan is `docs/DEVELOPMENT_ROADMAP.md`.

## 1. High-level model

```text
                 Cloudflare Worker
          pairing / auth / sync / media
                       ↕
   ┌──────────────────────────────┐
   │            Phone A           │
   │ React Native presentation    │
   │ application lifecycle        │
   │ domain use cases             │
   │ repository                   │
   │ SQLite + app-owned media     │
   │ SyncEngine + CloudClient     │
   └──────────────────────────────┘
                       ↕
              temporary mailbox
                       ↕
   ┌──────────────────────────────┐
   │            Phone B           │
   │ React Native presentation    │
   │ application lifecycle        │
   │ domain use cases             │
   │ repository                   │
   │ SQLite + app-owned media     │
   │ SyncEngine + CloudClient     │
   └──────────────────────────────┘
```

The cloud service is a temporary transport/mailbox layer, not permanent message history. Local SQLite remains authoritative for a device's durable history. The hardened Worker currently lives on `cloud/research`; the mobile integration work is on the focused runtime branch and is intended for `main` after validation.

The central architecture rule is that UI code consumes application/domain state and does not call HTTP or SQLite directly.

## 2. Current application architecture

```text
React Native screens/components
        ↓
application bootstrap + presentation state
        ↓
domain use cases
        ↓
RucolaRepository interface
        ↓
SQLiteRucolaRepository
        ↓
expo-sqlite + app-owned media

                 ┌──────────────────────┐
                 │ SyncEngine            │
                 │  ↕                    │
                 │ SQLite sync state     │
                 │  ↕                    │
                 │ CloudClient           │
                 └──────────┬───────────┘
                            ↓
                    temporary backend
```

The repository/domain boundary is already real. The cloud layer is also real at the client-transport level: `CloudClient` knows the typed pairing, sync, and media endpoints, while `SyncEngine` coordinates durable outbox/pull-cursor/ACK semantics.

The application still uses hand-rolled screen/navigation state and is scheduled for a later Expo Router cleanup. `CloudRuntime` now owns the online sync lifecycle instead of screens constructing `SyncEngine` or `CloudClient` directly.

Screens must not depend directly on SQLite or HTTP. Domain code must not depend on React Native.

## 3. Local data is authoritative for history

Historical messages persisted on a device are permanent application data unless a future explicit export/deletion feature removes them.

A backend outage must not make existing local history disappear or become inaccessible.

The cloud mailbox is therefore a synchronization mechanism, not a remote archive or history-recovery service.

## 4. Relationship and message model

The current local implementation has one fixed relationship ID (`the-one`) because there is only one relationship per installation. This is an implementation simplification, not a wire-level identifier that must be reused by the cloud service.

Each participant is allowed at most one active message. SQLite enforces the active-slot relationship and participant constraints at the database level.

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
4. create/update any required local sync state for a future send;
5. commit the transaction.

The previous message is never deleted, so it becomes immutable history automatically because it is no longer referenced by the participant's active slot.

The same semantic must hold when synchronization delivers several partner messages while a recipient was offline.

Home presents the latest partner message as the central relationship state. It is not a conventional chat transcript.

## 6. Three-day Home state

The product defines a time-based presentation rule:

- a recent partner message is shown normally;
- after three days without a newer partner message, Home should transition to a gentle stale/waiting prompt;
- the old message remains in immutable History.

The current implementation does not yet complete this rule end-to-end. The timestamp rule belongs in testable application/domain logic rather than arbitrary screen decoration.

## 7. Offline synchronization model

The current client/server contract is designed around durable local state and at-least-once delivery:

```text
Sender creates A, B, C locally
          ↓
Durable outbox with senderSeq 1, 2, 3
          ↓
Cloud Worker mailbox
          ↓
Recipient pulls bounded batches
          ↓
Validate/decrypt each item
          ↓
SQLite transaction
  ├─ persist accepted messages
  ├─ update active/history state
  └─ advance durable pull cursor
          ↓
COMMIT
          ↓
ACK server cursor
```

The server preserves accepted messages until their mailbox lifecycle permits cleanup. It does not collapse a burst to only the final active message.

Pull is directional: the recipient does not receive its own outbound mailbox rows. ACK is also directional: a device acknowledges only partner-originated rows delivered to that device.

## 8. Durable sync state and retention

The current SQLite schema is **version 6** and contains:

- `sync_state` — device identity/participant metadata, next sender sequence, durable pull cursor;
- `sync_outbox` — pending outbound messages, sender sequence, retry timing, attempts, blocked state, and the encrypted envelope persisted for retry idempotency;
- `sync_inbox` — locally applied inbound messages keyed by relationship/message ID and server sequence.

Outbound unsynchronized work has a **30-day local retention window**. At expiry, stale outbound messages are terminally removed rather than retried forever, including their local history entries. The active slot is cleared when the stale local message is removed.

The Worker mailbox currently retains undelivered messages for **14 days** and durable delivery receipts for **30 days**. Attached temporary media remains protected while its durable receipt exists and is eligible for cleanup after that retention window. Pending media has its own short lifecycle and ready media is finite-lived.

These finite retention windows are delivery/lifecycle boundaries, not read-state semantics.

## 9. Sync failure semantics

The mobile sync engine deliberately separates expected bad input from unexpected failures.

- A structurally invalid sender/participant/message identifier is a protocol error and stops the affected sync run.
- An expected undecryptable inbound item may be recorded as dropped so a corrupt item does not permanently block later server sequences.
- A type mismatch is treated as a dropped inbound item.
- Unexpected codec/runtime failures propagate instead of silently advancing the cursor.
- The cursor is advanced only by the durable local commit path.
- ACK is sent only after that commit succeeds.
- A failed local commit must therefore never be acknowledged to the server.

The E2E v1 codec is implemented for TEXT/EMOJI. `CloudRuntime` constructs it only for an active persisted relationship identity. Expected cryptographic/decryption failures use the explicit discardable error contract rather than broad exception swallowing. Outbound ciphertext is generated once and durably stored before the first network push so an ambiguous retry reuses the exact AES-GCM envelope.

## 10. Prototype cloud runtime

The first real online milestone uses one application-owned cloud runtime:

```text
CloudRuntime
 ├─ CloudIdentityStore
 ├─ CloudClient
 ├─ SyncCodec
 ├─ SQLiteSyncStateStore
 └─ SyncEngine
```

The runtime owns startup/foreground/after-send synchronization and keeps screens independent from HTTP and SQLite implementation details.

The existing health probe belongs inside this lifecycle. A successful health request means only that the configured Worker is reachable; it is not evidence that pairing or message synchronization is configured.

The runtime loads persisted cloud identity state and constructs the authenticated sync path only when the relationship is paired and the required encryption key is present.

## 11. Prototype E2E v1

The first two-device prototype uses a random 256-bit relationship key generated locally by the initiating device.

The key is transferred or established through the hidden pairing session. The Worker must never receive or store the raw key. The Worker may receive a one-way proof/hash or other protocol metadata needed to bind the pairing request, plus normal device/relationship state.

This is deliberately simpler than adding X25519 or a ratcheting protocol at this stage. A server-mediated public-key exchange by itself would not establish peer authenticity against a malicious server.

Message payload encryption uses AES-256-GCM with:

- a fresh nonce/IV for every message;
- a 16-byte authentication tag;
- a versioned wire envelope;
- authenticated additional data binding relationship/message context.

At minimum, the authenticated context covers relationship ID, message ID, message type, sender sequence, and encryption version.

The relationship key and cloud authentication credential are separate secrets and are stored locally through a secure secret-storage abstraction.

This E2E v1 design protects message content from the cloud service under the intended server-storage threat model. It does not claim protection against a compromised device or malicious software running on the user's endpoint.

## 12. Media lifecycle

Photo/video messages use the real device picker/camera path. Selected or captured media is copied into an app-owned document `media/` directory before the message is persisted. Message history stores the durable local URI and can render images or videos from that URI.

The current mobile synchronization engine does not yet upload/synchronize photo/video messages end-to-end. The Worker already has the corresponding media reservation/upload/completion lifecycle on `cloud/research`.

Drawing remains a declared message type but is intentionally not implemented yet.

If a media message fails to persist after the file has been copied, the newly copied file is removed. Clearing local data removes database state first and then attempts to remove app-owned media files; missing or already-unreadable files do not prevent the database reset from completing.

Media deletion only accepts direct children of the app-owned media directory, preventing a malformed stored URI from escaping that directory through path traversal.

## 11. Database migrations

SQLite uses `PRAGMA user_version` for schema versioning. The current schema is **version 5**.

Fresh databases are created directly at the latest schema. Legacy version-0/version-1 databases are migrated to the current schema; later versions add the durable synchronization tables and blocked-outbox state.

Migration validation checks legacy active-message slots, numeric fields, required relationships/messages, final schema version, and foreign-key integrity. A database newer than the application is rejected rather than downgraded. Migration failures abort their transaction so the old database is not partially replaced.

The native integration harness verifies the current schema and migration behavior using disposable databases rather than the normal `rucola.db`.

## 12. Pairing/security direction

Fresh installations use anonymous device identities. There is no normal account-registration or login UX.

### User-facing contract

The **only pairing credential shown to a user is exactly five emojis**.

Two transports enter the same pairing core:

~~~text
five emojis entered manually ─┐
                              ├─→ hidden pairing session → relationship ACTIVE
share link / five-emoji path ─┘
~~~

Technical invitation tokens, device IDs, relationship IDs, cloud credentials, serialized pairing packages, and relationship encryption keys remain implementation details.

### Security split

The five-emoji sequence is a short-lived pairing password/rendezvous secret. It is not the relationship encryption key.

The first online prototype continues to use the existing random 256-bit relationship key generated locally by the initiating device. The hidden pairing protocol must move/establish that key confidentially without sending the raw key to the Worker. The implementation must use a vetted password-authenticated/key-establishment construction or an equivalent reviewed primitive rather than inventing a custom password protocol.

The existing Worker invitation lifecycle remains useful:

- one-time invitations;
- expiry;
- bounded invalid-attempt handling;
- relationship-key commitment;
- server-authenticated relationship binding;
- explicit PAIRING → ACTIVE state transition.

### Unicode pairing code

The five displayed symbols are canonical protocol tokens, not arbitrary visual characters. The implementation must define one exact representation for each allowed emoji, including any variation selectors or multi-code-point emoji sequences.

URL decoding, Unicode handling, and input normalization must produce the same canonical representation before comparison.

### Share links

The preferred user-facing form is:

    https://rucola.njco.dev/<five-emojis>

The link contains no raw cryptographic key or serialized pairing package. GET/HEAD handling must not consume an invitation, and pairing-specific paths must not be intentionally cached, indexed, analytics-tracked, or written verbatim to diagnostic logs.

Android should use a verified App Link for rucola.njco.dev; the website is only the fallback/entry point for devices without the app.

### Implementation direction

Keep PairingManager, CloudIdentityStore, the relationship-key commitment, invitation lifecycle, secure credential storage, and existing tests where their semantics remain correct.

Replace screen-facing package handling with a transport-neutral pairing API:

~~~text
startPairing()
  → fiveEmojis + shareUrl + expiry

acceptByEmojis(fiveEmojis)
acceptFromShareLink(url)

          ↓

common PairingManager / hidden session
          ↓

existing invitation + identity lifecycle
~~~

The target is a transport refactor, not a pairing-system rewrite.

Real two-device pairing is not complete until both transports have been exercised on physical Android devices and encrypted message synchronization still works afterwards.

## 13. Cloud backend

Current direction:

- Cloudflare Workers — API, authentication, pairing, synchronization orchestration;
- D1 — relationship, mailbox, receipt, and media-lifecycle metadata;
- R2 — temporary media bytes.

The hardened Worker currently lives on `cloud/research`. Its protocol includes:

- device-bound authentication;
- two-person pairing state;
- directional push/pull/ACK semantics;
- durable receipts;
- sender/server sequence handling;
- bounded media uploads;
- cleanup and retention;
- concurrency/idempotency hardening.

The Worker stores ciphertext rather than plaintext message contents. E2E v1 for the first online prototype is an application-level AES-256-GCM design; the Worker remains unaware of the relationship key. Longer-term key rotation/recovery and asymmetric identity protocols remain later application decisions.

The cloud branch is a parallel workstream, not the current `main` application baseline. The next integration milestone is to connect the mobile lifecycle to the already-hardened protocol rather than redesign the transport.

## 14. Widgets and notifications

The long-term Android Home widget is an extension of the same Home state, not a separate message model.

Widgets should read local state and never require a network request just to render the current partner message.

Push notifications are complementary. They should generally prompt synchronization/re-entry rather than become the primary message-reading experience or carry sensitive message content.

Background synchronization is not yet implemented and must respect Android platform execution limits.

## 15. Unpairing

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

## 16. Core invariants for tests

Tests should protect at least:

1. one relationship per local installation;
2. exactly two participants once paired;
3. at most one active message per participant at the database level;
4. normal relationship lifecycle establishes the partner active message and creates the own active message when the user first sends one;
5. creating a new message archives the previous active message;
6. history is not destroyed by ordinary replacement;
7. both participants' messages coexist in local history;
8. message order is deterministic and sync order is tracked separately from timestamps;
9. persistence survives process/app restarts;
10. invalid message input is rejected before persistence;
11. photo/video media-only messages remain valid with durable app-owned media;
12. drawing remains intentionally unimplemented until a real editor exists;
13. legacy databases migrate to schema v5 without losing valid data;
14. malformed legacy data causes migration to fail without a partial migration;
15. sender sequence is durable across restarts;
16. offline synchronization preserves accepted message bursts;
17. inbound cursor advancement occurs only after durable local commit;
18. ACK occurs only after durable local commit;
19. own outbound messages are not returned by directional pull;
20. ACK cannot delete partner messages that were not durably delivered to the acknowledging device;
21. expected undecryptable inbound items cannot permanently block later cursor positions;
22. expired local outbox items are terminally removed at the defined 30-day boundary;
23. the three-day stale Home state does not delete or alter history.

## 17. Technology rule

Use the current Expo/React Native stack and stable Expo-compatible packages. Do not add dependencies merely to make a small feature look architectural.

The owner is deliberately postponing detailed visual implementation. Functional behavior, local correctness, coherent navigation/interaction order, and clean boundaries take priority until the feature set is complete.

The product is Android-first. Do not introduce platform abstractions merely for theoretical iOS support unless they simplify the current architecture without compromising Android delivery.
