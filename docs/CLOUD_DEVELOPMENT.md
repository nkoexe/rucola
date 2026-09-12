# Rucola Cloud Development Plan

> Status snapshot and implementation plan for the `cloud/research` branch.
>
> Research date: 2026-09-12.

## 1. Purpose

This document is the working plan for completing Rucola's cloud backend without coupling the local-first React Native application to the network.

The cloud service is a **temporary synchronization mailbox**, not the authoritative store of user history. Local SQLite remains authoritative on each device. The backend exists to move encrypted messages and temporary media between devices while a participant is offline.

The implementation must preserve these product-level properties:

- the app remains useful offline;
- existing local history survives backend outages;
- a message is not considered synchronized merely because the server accepted it;
- a recipient acknowledges a message only after durable local persistence;
- the server may delete a mailbox item only after acknowledgement;
- server code never needs plaintext message content;
- the UI talks to domain/repository code rather than directly to HTTP endpoints.

## 2. Current branch status

The branch already contains a real Cloudflare Worker/D1 backend foundation.

### Implemented

- Cloudflare Worker entrypoint and routing.
- D1 schema and initial migration.
- Device credentials and authentication probing.
- Pairing bootstrap.
- Invitation creation and acceptance.
- Invitation expiry and single-use semantics.
- Confirmation-code attempt limiting/lockout.
- Pairing bootstrap rate limiting.
- Relationship lifecycle: `PAIRING`, `ACTIVE`, `ENDED`.
- Message push endpoint.
- Message payload validation and size limits.
- Message-ID idempotency/conflict detection.
- Sender-sequence conflict detection.
- Relationship-local server sequence allocation.
- Temporary mailbox retention timestamps.
- Media-upload metadata model and attachment validation in message push.
- D1 primary-session verification after a write, anticipating read replication.
- Worker, pairing-hardening, and sync-push test suites.

### Explicitly incomplete

- `GET /v1/sync/pull`.
- `POST /v1/sync/ack/...`.
- Mailbox cleanup after acknowledgement.
- Complete media upload/download lifecycle.
- R2 binding and production bucket configuration.
- Client-side cloud transport in the React Native branch.
- Background synchronization.
- Push notification integration.
- End-to-end cryptographic implementation/key management.
- Production Cloudflare database/bucket configuration.

The Worker currently exposes pull and acknowledgement routes as intentional `501 NOT_IMPLEMENTED` responses. Do not treat those routes as accidentally missing functionality.

## 3. Existing backend model

The D1 migration currently defines:

- `relationships`
- `devices`
- `invitations`
- `media_uploads`
- `mailbox_messages`

Important mailbox invariants already represented in SQL include:

- unique `(relationship_id, message_id)`;
- unique `(relationship_id, sender_device_id, sender_seq)`;
- unique `(relationship_id, server_seq)`;
- one mailbox message per media upload;
- relationship status checks;
- positive sequence numbers;
- mailbox expiry timestamps;
- acknowledgement timestamps.

The existing push path validates the relationship, authenticates the device, validates the message, detects replay/conflict cases, allocates a server sequence, writes the message, and verifies the committed state before returning success.

## 4. Target synchronization protocol

The core protocol is:

```text
Sender device
    |
    | POST /v1/sync/push
    v
Cloud mailbox (D1)
    |
    | GET /v1/sync/pull?after=<cursor>
    v
Recipient device
    |
    | persist message transactionally in local SQLite
    |
    | POST /v1/sync/ack
    v
Cloud mailbox
    |
    | remove acknowledged temporary copy
    v
D1 cleanup
```

### Critical rule

**Pull is not acknowledgement.**

A successful pull means only that the server returned a mailbox item. The item remains available until the recipient explicitly acknowledges it.

The recipient must:

1. receive a batch;
2. validate/decrypt it as appropriate;
3. persist it to local SQLite in the correct local order;
4. commit that local transaction;
5. only then send the acknowledgement.

If the app crashes between steps 3 and 5, the message must be returned again on a later pull. The local persistence operation must therefore be idempotent.

## 5. Pull API design

### Proposed endpoint

`GET /v1/sync/pull`

Authentication is the same device credential mechanism already used by push.

### Query parameters

Use a relationship-local server sequence cursor rather than timestamps.

Proposed parameters:

- `after`: last server sequence durably acknowledged by the client;
- `limit`: bounded batch size, with a conservative server maximum.

The client should normally request messages with:

```text
server_seq > after
ORDER BY server_seq ASC
LIMIT limit
```

### Proposed response shape

```json
{
  "messages": [
    {
      "messageId": "...",
      "senderParticipant": "ME",
      "senderSeq": 12,
      "serverSeq": 41,
      "type": "TEXT",
      "ciphertext": "...",
      "encryptionVersion": 1,
      "createdAt": 1770000000000,
      "mediaUploadId": null
    }
  ],
  "nextCursor": 41,
  "hasMore": false
}
```

The exact wire naming may be adjusted during implementation to match the mobile sync domain model. The semantic requirements are more important than the field spelling.

### Pull invariants

- Only the authenticated device's relationship is queried.
- Only an `ACTIVE` relationship may synchronize.
- Messages are returned in ascending `server_seq` order.
- The server never returns messages from another relationship.
- The server never exposes another device's credential.
- A cursor does not delete or acknowledge anything.
- A client can safely repeat a pull request.
- Batch size is bounded.
- Expired mailbox entries are not returned.
- Pulling an item does not modify its acknowledgement state.

### Cursor semantics

The client should treat `serverSeq` as an opaque monotonic position, not as a timestamp.

Do not advance the durable local cursor until the corresponding messages have been persisted locally.

A practical MVP rule is to acknowledge the highest contiguous server sequence that is durably persisted. If a future implementation supports holes or partial acknowledgement, it must not acknowledge a later sequence while leaving an earlier required message unpersisted.

## 6. Acknowledgement API design

### Proposed endpoint

`POST /v1/sync/ack`

The acknowledgement body should contain a bounded list of server sequence numbers or, preferably for the MVP, a single contiguous high-water mark:

```json
{
  "throughServerSeq": 41
}
```

The high-water-mark form is preferred because it maps directly to ordered pull semantics and makes the client's durable cursor easy to reason about.

### Acknowledgement invariants

- The device must be authenticated.
- The relationship must be active.
- The supplied sequence must be a positive safe integer.
- The server must only affect rows belonging to the authenticated relationship.
- Acknowledgement must be monotonic.
- Repeating the same acknowledgement must be harmless.
- Acknowledging a sequence greater than the server's known sequence must be rejected or safely clamped; choose one behavior and document it. Rejection is preferable for protocol mistakes.
- The server should mark/delete only messages that are actually eligible for acknowledgement.
- Acknowledgement must not alter message contents.

## 7. Mailbox cleanup strategy

The MVP should keep cleanup tied to acknowledgement rather than relying on a periodic task for correctness.

Recommended sequence:

1. authenticate device;
2. validate the high-water mark;
3. transactionally mark eligible mailbox rows acknowledged;
4. remove acknowledged rows after the acknowledgement has been durably recorded, or use a single transaction if the chosen D1 schema makes that safe;
5. retain enough information to make repeated acknowledgement idempotent.

The important invariant is that a message must never disappear before the recipient has had a chance to durably persist it.

A later cleanup mechanism may remove abandoned/expired rows, but expiry is a recovery mechanism, not the normal delivery acknowledgement path.

## 8. Local client contract

The React Native branch should eventually implement synchronization below the existing repository boundary:

```text
UI
 ↓
domain use cases
 ↓
RucolaRepository
 ↓
SQLite repository + sync engine
 ↓
Cloud transport
```

The UI must not call `/v1/sync/*` directly.

The local database remains the source of truth. Network state should be represented as synchronization state rather than replacing local records with server responses.

### Receive path

```text
HTTP pull
  ↓
validate wire payload
  ↓
decrypt/verify when crypto layer exists
  ↓
SQLite transaction
  ├─ insert missing messages
  ├─ ignore already-persisted messages safely
  ├─ update active-message slot according to normal local semantics
  └─ advance durable sync cursor
  ↓
commit
  ↓
ACK server high-water mark
```

### Send path

```text
local message creation
  ↓
SQLite commit
  ↓
mark pending synchronization
  ↓
POST push
  ↓
record server sequence / synchronization state
  ↓
retry on transient failure
```

The local write must not depend on network availability.

## 9. Idempotency requirements

Both sides must be safe under retries.

### Push retries

Already implemented server behavior should remain:

- same `messageId` + same immutable payload → return the existing server assignment;
- same `messageId` + different payload → conflict;
- same sender sequence assigned to another message → conflict.

### Pull retries

A client may receive the same mailbox item repeatedly if it crashes before acknowledgement. Local persistence therefore needs a stable unique message ID and must turn duplicate delivery into a no-op rather than duplicate history.

### ACK retries

Acknowledging the same high-water mark multiple times must be safe.

### Network failures

A timeout does not mean the server rejected a request. Every operation must be designed around retry-safe semantics rather than trying to infer success from transport failure.

## 10. Concurrency and ordering

Server sequence allocation is relationship-local and must remain unique.

Do not replace the existing server-sequence mechanism with timestamps. Timestamps cannot provide a reliable total order under concurrent requests.

The existing push implementation uses a compare-and-retry strategy around `next_server_seq`. Keep this behavior and expand tests around concurrent pushes before changing it.

Where a write is followed immediately by a consistency-sensitive read, use the D1 Sessions API appropriately. Cloudflare documents `first-primary` sessions as the way to begin from the latest database version, with subsequent session queries remaining sequentially consistent. This is particularly relevant if D1 read replication is enabled later.

## 11. Media / R2 plan

Media should not be placed into D1.

The intended lifecycle is:

```text
client
  ↓
POST media initiation
  ↓
D1 media_uploads = PENDING
  ↓
obtain short-lived upload authorization
  ↓
client uploads encrypted blob to R2
  ↓
POST media completion
  ↓
D1 media_uploads = READY
  ↓
push PHOTO_VIDEO message referencing mediaUploadId
  ↓
media_uploads = ATTACHED
  ↓
recipient pulls message
  ↓
recipient obtains authorized media access
  ↓
recipient persists media locally
  ↓
recipient ACKs message
  ↓
server can delete temporary R2 object
```

R2 presigned URLs are suitable for direct temporary object access. They are bearer tokens and should therefore be short-lived and scoped to a single object/operation. Cloudflare currently documents GET, PUT, HEAD and DELETE presigned operations, with expiries up to seven days.

For Rucola, prefer short expiries and opaque object keys. Never expose a user's relationship ID as a predictable public object path unless there is a concrete reason to do so.

The message ciphertext and media ciphertext should be treated as opaque by the server. E2E encryption must be implemented on the client side before the cloud service is considered privacy-complete.

## 12. Security plan

### Existing protections to retain

- random device credentials;
- credential hashes in D1;
- random invitation tokens;
- invitation token hashes in D1;
- short human confirmation code used only as an additional pairing check;
- invitation expiry;
- single-use invitations;
- confirmation attempt lockout;
- bounded request bodies;
- bounded identifiers;
- explicit relationship ownership checks;
- route-specific method checks;
- pairing bootstrap rate limiting.

### Additional work before production

- rate-limit authenticated sync endpoints appropriately;
- avoid IP-only rate limiting where a stable authenticated identifier is available;
- audit all error responses for information leakage;
- ensure credentials/tokens are never logged;
- add replay/concurrency tests around pairing and acknowledgement;
- add authorization tests for every relationship-scoped query;
- add media object authorization tests;
- establish secret/configuration handling for production resources;
- establish abuse limits for mailbox size and media volume;
- define expiry/garbage-collection behavior for abandoned media.

Cloudflare's current Worker Rate Limiting API is intentionally eventually consistent and local to the Cloudflare location handling a request, so it should be treated as an abuse-control mechanism rather than an exact accounting system. Authenticated per-device/resource keys are preferable to relying solely on client IPs.

## 13. Production infrastructure plan

Development and production must use separate resources.

### Development

- local Wrangler Worker;
- local D1 database;
- local test R2 bucket when required;
- deterministic test fixtures only;
- no production secrets.

### Production

- dedicated Cloudflare Worker deployment;
- dedicated D1 database;
- dedicated R2 bucket;
- real rate-limit namespace IDs;
- production configuration/secrets outside source control;
- observability and error reporting;
- documented deployment/migration procedure.

The current Wrangler configuration intentionally points at a placeholder D1 database ID, so production infrastructure must not be inferred from the current development config.

## 14. Test strategy

Cloud work should be developed test-first where practical. Every protocol feature should have both happy-path and failure-path coverage.

### Pairing

- bootstrap creates exactly one relationship/device/invitation;
- bootstrap rate limit triggers;
- invitation expires;
- invitation can only be consumed once;
- wrong confirmation code increments failure count;
- lockout is enforced;
- a second active partner cannot be created;
- invalid credentials are rejected;
- credentials are not returned after initial creation.

### Push

- valid push succeeds;
- invalid JSON/content type fails;
- oversized payload fails;
- invalid message type fails;
- invalid sequence fails;
- future/invalid timestamps fail;
- same message retry is idempotent;
- same ID with different payload conflicts;
- same sender sequence with another ID conflicts;
- PHOTO_VIDEO requires a valid READY media upload;
- inactive relationship rejects push;
- concurrent sequence allocation does not duplicate server sequence numbers.

### Pull

- only own relationship is visible;
- ordering is ascending `server_seq`;
- `after` excludes already-positioned messages;
- limit is enforced;
- expired messages are excluded;
- repeated pull returns the same unacknowledged messages;
- pull does not acknowledge messages;
- inactive/revoked devices are rejected.

### ACK

- valid high-water mark acknowledges eligible messages;
- repeated ACK is harmless;
- lower ACK does not move state backwards;
- future ACK is rejected;
- another relationship's messages are untouched;
- ACK before persistence cannot happen from the server's perspective because the server only receives the ACK after client persistence;
- acknowledged mailbox messages are eventually/transactionally removed according to the chosen cleanup implementation.

### End-to-end sync

At minimum, test this scenario:

```text
A online
B offline

A sends message 1
A sends message 2
A sends message 3

B comes online
B pulls 1..3
B persists all three in one local transaction
B crashes before ACK

B comes back
B pulls 1..3 again
B local persistence is idempotent
B ACKs through 3

Server no longer needs mailbox copies of 1..3
```

This is the most important failure/recovery scenario in the cloud MVP.

## 15. Implementation phases

### Phase 0 — protocol lock and audit

**Status: current phase**

- freeze the semantics documented here;
- inspect current push/pairing code for assumptions pull/ACK must preserve;
- inspect all existing tests before implementation;
- identify schema changes before touching endpoint code.

### Phase 1 — Pull

**Next implementation milestone**

1. define request/response types;
2. implement authenticated relationship-scoped query;
3. implement ordered cursor pagination;
4. exclude expired entries;
5. add route;
6. add tests;
7. review authorization and pagination edge cases.

Completion criterion: a recipient can repeatedly pull an unacknowledged mailbox without data loss or reordering.

### Phase 2 — ACK and cleanup

1. define high-water-mark request;
2. implement monotonic validation;
3. implement acknowledgement transaction;
4. implement mailbox cleanup;
5. add idempotency/concurrency tests;
6. review crash boundaries.

Completion criterion: pull → local persistence → ACK can safely complete, and retries cannot lose or duplicate messages.

### Phase 3 — Cloud protocol hardening

1. audit every route for relationship isolation;
2. add abuse/rate limits;
3. add boundary tests;
4. test concurrent push/pull/ACK interactions;
5. test expiry behavior;
6. test malformed inputs and oversized inputs;
7. run a second independent code review.

Completion criterion: the Worker can be treated as a coherent synchronization service rather than a collection of endpoints.

### Phase 4 — R2 media

1. add R2 binding/configuration;
2. implement media initiation;
3. implement upload authorization;
4. implement completion verification;
5. enforce media ownership;
6. attach media to pushed messages;
7. implement recipient download authorization;
8. implement temporary-object cleanup;
9. test interrupted uploads and abandoned objects.

Completion criterion: PHOTO/VIDEO can travel end-to-end without putting binary data into D1.

### Phase 5 — React Native cloud adapter

This work belongs on the React Native migration branch and should consume the protocol rather than redesign it.

1. define cloud transport interface;
2. store device credential securely;
3. implement pairing client;
4. implement push client;
5. implement pull client;
6. implement ACK after local transaction commit;
7. implement retry/backoff;
8. persist sync cursor;
9. integrate with repository/use-case boundaries;
10. test offline/online transitions.

Completion criterion: two real installations can pair and exchange messages while either device is offline.

### Phase 6 — Background execution and notifications

1. background sync where platform permits;
2. push notification transport;
3. notification contains no message plaintext;
4. notification triggers synchronization rather than being the source of truth;
5. handle duplicate/missing notifications safely.

Completion criterion: notifications improve latency but are not required for correctness.

### Phase 7 — End-to-end encryption

Encryption is a separate security milestone, not something to bolt onto an already-deployed plaintext protocol.

1. define key model;
2. define pairing key exchange;
3. define message encryption envelope/versioning;
4. define media encryption;
5. implement client-side crypto;
6. test key rotation/re-pairing/revocation semantics;
7. verify server cannot decrypt message content.

Completion criterion: the backend can operate entirely on opaque ciphertext and still perform routing, sequencing, expiry, and cleanup.

### Phase 8 — Production readiness

1. create production Cloudflare resources;
2. separate production config from local config;
3. establish migration/deployment process;
4. configure observability;
5. establish retention/cleanup monitoring;
6. perform load/abuse tests;
7. perform security review;
8. document rollback/recovery procedure;
9. deploy only after end-to-end tests pass.

## 16. Parallel work

Cloud development can proceed in parallel with React Native UI work, but shared protocol assumptions must remain stable.

### Safe to do in parallel now

- cloud pull/ACK implementation;
- cloud tests;
- cloud schema review;
- cloud security audit;
- React Native local sync-state model;
- repository sync abstraction;
- UI for offline/online/sync indicators;
- pairing UI behind an abstraction;
- local persistence idempotency work.

### Coordinate before changing

- message wire format;
- message types;
- synchronization state names;
- relationship lifecycle semantics;
- media identifiers;
- encryption envelope/version;
- server/client cursor semantics.

### Avoid for now

- building UI directly around undocumented HTTP responses;
- deploying production infrastructure before pull/ACK semantics are stable;
- implementing push notifications as a substitute for synchronization;
- putting plaintext message content in cloud logs;
- introducing a second backend architecture while the Worker/D1/R2 design is still viable.

## 17. Definition of cloud MVP complete

Cloud MVP is complete when all of the following are true:

- two devices can establish a real relationship;
- each device has an authenticated device credential;
- either device can create a message locally while offline;
- pending messages can be pushed safely;
- the other device can pull messages in deterministic order;
- repeated pulls do not lose messages;
- local persistence is idempotent;
- ACK occurs only after local durability;
- acknowledged mailbox messages are cleaned up safely;
- temporary media can be transferred when implemented;
- backend outages do not destroy local history;
- server never needs plaintext message content;
- end-to-end tests cover offline delivery, retries, crashes, and concurrent operations.

## 18. Current recommendation

Do **not** start with R2, notifications, or production deployment.

The highest-value next step is:

> **Implement and thoroughly test `sync/pull`, then `sync/ack` and mailbox cleanup.**

This closes the central server-side synchronization loop while preserving the existing local-first architecture.

After that, perform a dedicated hardening pass before touching media infrastructure.

## 19. External platform notes

Cloudflare documentation checked during this plan:

- D1 Sessions provide sequential consistency and `first-primary` can start a session from the latest database state. This supports the existing post-write verification approach and should be used deliberately if read replication is enabled. See Cloudflare's D1 read replication documentation.
- R2 presigned URLs provide temporary scoped GET/PUT/HEAD/DELETE access and should be treated as bearer tokens. This is the preferred direction for direct mobile media transfer once the R2 phase begins.
- Workers Rate Limiting is useful for abuse protection, but its counters are eventually consistent and location-local; it must not be used as an exact accounting mechanism.

## 20. Change log

### 2026-09-12

- Audited the `cloud/research` branch.
- Confirmed Worker routing, pairing, D1 schema, push synchronization, and existing test coverage.
- Confirmed `/v1/sync/pull` and `/v1/sync/ack/*` are intentionally not implemented yet.
- Reviewed the existing local-first architecture constraints.
- Researched current Cloudflare D1 Sessions, R2 presigned URL, Worker R2 binding, and Rate Limiting behavior.
- Added this document as the cloud implementation source of truth.
