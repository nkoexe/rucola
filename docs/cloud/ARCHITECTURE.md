# Rucola Cloud / Mailbox Architecture Research

**Status:** research/design only; no backend implementation in this document.

**Branch basis:** `migration/react-native` at commit `52447d8e1039a3d8b1529501ebd57621acbc85cc` (`chore: update expo dependencies to latest compatible versions`). This research lives on `cloud/research` so it does not interfere with the active React Native migration branch.

## 0. Executive recommendation

Use **Cloudflare Workers + one D1 database + one private R2 bucket** for the first real cloud service.

The backend should be a deliberately boring temporary mailbox:

```text
React Native app
   |
   | HTTPS + device bearer credential
   v
Cloudflare Worker
   |-- D1: relationships, devices, invitations, mailbox metadata/payloads, ACKs
   `-- R2: temporary encrypted media objects

Phone SQLite remains the permanent archive/source of truth.
```

The Worker should not expose D1 or R2 directly. It authenticates a device, authorizes it against exactly one two-person relationship, validates the request, performs small atomic D1 operations, and issues short-lived R2 presigned URLs where appropriate.

**Do not add Durable Objects for the first implementation.** D1 already gives the required transactional ordering and uniqueness guarantees, while the application's scale is tiny. A relationship-scoped Durable Object could serialize mailbox operations even more explicitly, but it adds another stateful primitive and does not buy enough for two devices. Reconsider it only if production testing exposes a real ordering/coordination problem.

The most important design decision is to store three different notions of order:

1. **client creation order** — what the originating device says happened locally;
2. **server receipt/order** — the deterministic order assigned by the mailbox when accepted;
3. **local logical/history order** — the ordering policy used by clients when presenting merged history.

A wall-clock timestamp must never be the only ordering or identity mechanism.

---

## 1. Current implementation inspected

The React Native migration branch currently contains the local-first architecture described by `AGENTS.md`: Expo + React Native + TypeScript, `expo-sqlite`, app-owned media storage, repository/domain separation, and no networking yet.

The current domain model contains:

- `Relationship { id, partnerNickname, ownName, partnerColor, togetherSince }`
- `Message { id, relationshipId, participant, type, body, createdAt, isActive, syncState, orderIndex, mediaReference }`
- `Participant = ME | PARTNER`
- `MessageType = TEXT | EMOJI | PHOTO_VIDEO | DRAWING`
- `SyncState = LOCAL_ONLY | PENDING | SYNCED | FAILED`

The current SQLite schema is version 2 and has `relationships`, `messages`, and `active_message_slots`. Messages already have stable IDs, `createdAt`, `orderIndex`, `syncState`, and `mediaReference`. `active_message_slots` is the authoritative local representation of the active message.

The current repository creates message UUIDs locally, allocates a local `orderIndex`, and performs message insertion + active-slot replacement inside a local SQLite transaction. Photo/video references point to app-owned local files.

This is a good foundation for cloud synchronization, but several fields are local concepts rather than sufficient network protocol state; see **Section 10 — Local model gaps**.

The product/architecture docs explicitly establish that the phone is the permanent store and that the server is only a temporary mailbox. They also require offline bursts such as A/B/C to survive synchronization in order, and require server deletion only after durable local persistence and acknowledgement.

### Assumptions

- There is exactly one relationship per installed account/device in the MVP model.
- A relationship has exactly two participants.
- Each participant may have one active message, but all historical messages are immutable.
- The server is not a backup and is not expected to reconstruct permanent history.
- A device may be offline for days or weeks.
- Future E2E encryption is a requirement, not a nice-to-have.
- Push/background synchronization is best-effort and cannot be assumed to execute immediately.

---

## 2. Why Cloudflare remains a good fit

### Workers

Workers are a good API boundary for this application. The service needs only a small HTTP API, authentication, authorization, validation, D1 queries, and R2 signing. There is no need for a traditional always-on server.

Workers have no enforced response-body limit, while request-body limits make it undesirable to proxy large media through the Worker. Free/Pro request bodies are limited to 100 MB; Business to 200 MB; Enterprise has higher limits. Media should therefore bypass the Worker and go directly to R2.

### D1

D1 is appropriate for the **metadata and temporary mailbox state** here:

- SQLite semantics match the existing local mental model.
- foreign keys and unique constraints are available;
- `batch()` executes statements sequentially as a transaction and rolls the batch back if a statement fails;
- the database is small and write volume should be tiny;
- exactly-two-user relationships make the schema simple;
- the service does not need relational analytics or complex queries.

The important limitation is that each individual D1 database is inherently single-threaded: queries execute one at a time. That is not a concern at Rucola's expected scale, but it means the design should keep transactions short and avoid long-running application work inside them.

D1 is therefore a good fit **because Rucola is tiny**, not because D1 is an infinitely scalable queue.

### R2

R2 is a natural temporary media mailbox. It has no egress fee, supports object sizes far beyond anything Rucola needs, supports presigned URLs, and supports multipart uploads for large/resumable video uploads.

Use direct client-to-R2 uploads/downloads via short-lived presigned URLs. The Worker should never proxy normal media bytes.

### Cost

At this workload, cost should be negligible on a paid Cloudflare setup. Current D1 pricing includes 25 billion rows read/month and 50 million rows written/month on Workers Paid before overage; D1 storage has a 5 GB included amount. R2 Standard is currently $0.015/GB-month with no egress charge. The application should nevertheless enforce its own mailbox/media quotas so abuse cannot turn a cheap service into an unbounded storage bill.

---

## 3. Alternatives considered

### A. Cloudflare Workers + D1 + R2 — **recommended**

**Pros**
- Minimal number of services.
- SQLite semantics are familiar.
- Atomic D1 batches are enough for mailbox insertion/acknowledgement.
- R2 is purpose-built for media.
- No server fleet to maintain.
- Easy to keep API surface small.

**Cons**
- One D1 database serializes queries globally.
- D1 is not a queue service, so queue semantics must be implemented carefully.
- Cloudflare-specific deployment/vendor coupling.

### B. Workers + Durable Objects + R2

A relationship-scoped SQLite-backed Durable Object would provide a naturally serialized state machine per relationship.

**Why not initially:** it introduces a stateful coordination primitive that the product does not need yet. D1 already serializes the tiny amount of relational state involved and provides transactions. Durable Objects are a good future escape hatch if mailbox contention or relationship-scoped coordination becomes materially more complicated.

### C. Postgres/Supabase/Neon + object storage

Technically strong and familiar to many developers. It would provide excellent concurrency and SQL tooling.

**Why not:** substantially more infrastructure and operational surface for an application whose backend data volume is tiny. It solves problems Rucola does not currently have.

### D. Firebase/Firestore

Good mobile synchronization tooling and push integration.

**Why not:** pushes Rucola toward a cloud-authoritative/realtime document model, while the product explicitly wants an offline-first local archive and a temporary mailbox. It also makes the data model less boring than necessary.

### E. Queue-first architecture (Queues/Kafka/etc.)

Unnecessary. Rucola needs durable per-relationship mailbox records with acknowledgements, not a high-throughput distributed event bus.

---

## 4. Proposed server data model

Use one D1 database initially. Do **not** create one database per relationship: the isolation is unnecessary at this scale and would complicate migrations and operational management.

### `relationships`

```sql
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

There must be exactly two active participant rows for an active relationship.

### `devices`

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
  credential_hash BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX devices_relationship_participant
  ON devices(relationship_id, participant)
  WHERE revoked_at IS NULL;
```

A device credential is an opaque random bearer token generated with cryptographically secure randomness. Store only a cryptographic hash of it server-side.

If future multi-device support is desired, remove the uniqueness assumption and make `devices` explicitly multi-device; do not accidentally bake a one-device-per-person rule into the protocol.

### `invitations`

```sql
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  code_hash BLOB NOT NULL,
  created_by_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_device_id TEXT,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT
);

CREATE INDEX invitations_expiry
  ON invitations(expires_at);
```

The real invitation token is never stored plaintext. The human-facing code is also not a credential. If the UI needs code lookup, rate-limit it aggressively and treat the code as a confirmation/discovery aid only.

### `mailbox_messages`

```sql
CREATE TABLE mailbox_messages (
  relationship_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  sender_participant TEXT NOT NULL CHECK (sender_participant IN ('ME', 'PARTNER')),

  -- Monotonic sequence generated by the originating device for that participant.
  sender_seq INTEGER NOT NULL,

  -- Client creation information. Useful for audit/debugging and future conflict logic,
  -- but never used alone as a total ordering key.
  client_created_at INTEGER NOT NULL,

  -- Monotonic order assigned by the server when the message is accepted.
  server_seq INTEGER NOT NULL,
  server_received_at INTEGER NOT NULL,

  type TEXT NOT NULL CHECK (type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')),

  -- Future E2E: opaque encrypted envelope, not plaintext application content.
  ciphertext BLOB NOT NULL,
  encryption_version INTEGER NOT NULL DEFAULT 1,

  media_id TEXT,
  expires_at INTEGER NOT NULL,

  PRIMARY KEY (relationship_id, message_id),
  UNIQUE (relationship_id, sender_device_id, sender_seq),
  UNIQUE (relationship_id, server_seq),
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE RESTRICT
);

CREATE INDEX mailbox_pull
  ON mailbox_messages(relationship_id, server_seq);

CREATE INDEX mailbox_expiry
  ON mailbox_messages(expires_at);
```

`server_seq` is a per-relationship sequence, not a global application sequence. It is allocated atomically by the Worker while inserting the message. This gives the recipient a stable mailbox traversal order without pretending that server receipt order equals physical creation time.

A simpler implementation may use an integer `next_server_seq` field in `relationships` and increment it as part of the same D1 transaction/batch. An `AUTOINCREMENT` global ID is not desirable because the logical namespace should be per relationship and because a server-global ID unnecessarily exposes global traffic characteristics.

### `mailbox_acks`

```sql
CREATE TABLE mailbox_acks (
  relationship_id TEXT NOT NULL,
  recipient_device_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY (relationship_id, recipient_device_id, message_id),
  FOREIGN KEY (relationship_id, message_id)
    REFERENCES mailbox_messages(relationship_id, message_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_device_id) REFERENCES devices(id) ON DELETE RESTRICT
);
```

An ACK means **durably persisted locally**, not displayed/read.

For the first implementation, ACK rows may be avoided and acknowledgement state can be represented by a recipient cursor only if the server can prove that all earlier mailbox items have been durably persisted. Per-message ACKs are safer for retries, partial batches, and media failures. Optimize to a cursor later if measurements justify it.

### `media_objects`

```sql
CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('PHOTO', 'VIDEO', 'DRAWING')),
  declared_mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('PENDING', 'COMPLETE', 'ABANDONED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (relationship_id, message_id)
    REFERENCES mailbox_messages(relationship_id, message_id) ON DELETE CASCADE
);

CREATE INDEX media_expiry
  ON media_objects(expires_at);
```

The actual R2 object is the temporary bytes. D1 only contains the metadata required to authorize and clean it up.

---

## 5. D1 suitability analysis

### Exactly two users

Excellent fit. The relationship is a small relational boundary, and foreign keys/unique constraints can enforce the important invariants.

Do not depend solely on application code for:
- one active invitation per operation;
- unique device identities;
- unique message IDs;
- unique `(sender_device_id, sender_seq)`;
- unique `(relationship_id, server_seq)`.

### Immutable messages

Excellent fit. The API should never expose message UPDATE operations. After insertion, only acknowledgement/retention metadata may change.

The encrypted payload itself should be immutable.

### Ordering

Good fit, provided the schema stores more than a timestamp.

D1's serialized writes are useful for allocating `server_seq` deterministically. However, server order is **receipt order**, not creation order. The client must retain `sender_seq` and `client_created_at` separately.

### Idempotent uploads/sync

Good fit. A client-generated `message_id` plus unique `(sender_device_id, sender_seq)` gives the Worker two useful idempotency keys.

Retrying the same POST after a timeout must return the already accepted message rather than create a second mailbox item.

### Offline synchronization

Good fit. The mailbox is simply a durable set of pending records ordered by `server_seq`.

The recipient should pull after its last durable server cursor, persist locally in a SQLite transaction, then ACK only after that local transaction succeeds.

### Conflict handling

D1 can serialize server acceptance, but it cannot discover a universal real-world "creation order" between two disconnected devices. This is a distributed-systems fact, not a D1 limitation.

Use:
- sender-local monotonic sequence for per-device causality;
- server sequence for deterministic mailbox order;
- explicit rules for concurrent cross-participant messages.

Do not attempt to resolve concurrent messages using timestamps alone.

### Deletion / expiry

Good fit. D1 can delete acknowledged mailbox rows and stale rows through scheduled cleanup. R2 lifecycle rules provide a second safety net for stale media.

The server should be conservative: failure to clean up is preferable to deleting an unacknowledged message.

### Concurrent requests

D1 serializes work per database. This is more than enough for two-person relationships at the expected traffic level.

Transactions must be small:
- validate/authenticate before the transaction;
- do one compact D1 transaction to check idempotency, allocate `server_seq`, and insert metadata/payload;
- never perform R2 network transfers while holding a D1 transaction.

D1's `batch()` provides sequential transactional execution. If a statement fails, the batch rolls back. This is appropriate for message acceptance and ACK state changes.

---

## 6. Pairing protocol

### Goals

- The human-facing code is cute and easy to compare.
- The actual credential has high entropy.
- Invitation expires after approximately 24 hours.
- Invitation can be consumed exactly once.
- Replaying an old link cannot pair another device.
- Server learns only the minimum metadata necessary for routing and authorization.

### Proposed flow

#### 1. Unpaired device creates invitation

Device A already has an anonymous device credential.

`POST /v1/pair/invitations`

Worker creates:
- invitation ID;
- 32 random bytes of secure invitation token;
- short human-facing emoji code generated from a controlled alphabet;
- 24-hour expiry;
- server-side hashes of token and code.

Response contains a deep link carrying the **secure token**, plus the human-facing code for visual confirmation.

The code is not sufficient to authenticate or pair by itself.

#### 2. Device B opens the deep link

The app sends the invitation token to the Worker over HTTPS.

`POST /v1/pair/accept`

Worker verifies:
- token exists;
- token has not expired;
- token has not been consumed;
- relationship is still pairable;
- inviter still owns the invitation.

The Worker then atomically:
- creates the second device record;
- marks the invitation consumed;
- transitions the relationship to ACTIVE.

The operation must be idempotent for the successful device/token combination but must not allow a third device to reuse the invitation.

#### 3. Human confirmation

Both devices should display/confirm the same cute code before finalizing UX. This is a protection against accidentally accepting the wrong invitation, not cryptographic authentication.

### Important UX decision

If Rucola supports **manual code-only pairing**, the code becomes part of the security boundary unless another proof is exchanged. That conflicts with the requirement that the human code not be a credential.

**Recommendation:** manual entry should be a confirmation/discovery mechanism, while the secure token travels through a deep link/QR/share action. If manual code-only pairing is desired later, it needs a separate anti-bruteforce design and an explicit security decision.

### Token generation

Use Workers Web Crypto (`crypto.getRandomValues`) for invitation and device secrets. Never use `Math.random()` for security-sensitive values.

### What the server knows

The server necessarily knows:
- relationship ID;
- two anonymous participant/device IDs;
- message metadata needed for routing and retention;
- mailbox timestamps/sequences;
- media object metadata;
- IP/request metadata available through the platform for abuse prevention/operations.

With E2E encryption it should **not** know message plaintext, emoji content, photo/video content, or encryption keys.

Avoid collecting names, relationship dates, contacts, precise location, or address-book data server-side unless a future feature genuinely requires them.

---

## 7. Sync protocol

### Authentication

Every request after pairing uses a device bearer credential:

```text
Authorization: Bearer <opaque random device token>
```

The server stores only a hash of the token. Revocation deletes/invalidates the credential record.

This is deliberately simpler than OAuth. There are no normal user accounts, passwords, email addresses, social logins, or third-party identity providers.

### Message upload

`POST /v1/sync/push`

Conceptual payload:

```json
{
  "messages": [
    {
      "messageId": "device-generated-uuid",
      "senderSeq": 42,
      "clientCreatedAt": 1780000000000,
      "type": "TEXT",
      "ciphertext": "...",
      "encryptionVersion": 1,
      "mediaId": null
    }
  ]
}
```

The Worker:

1. authenticates the device;
2. verifies the relationship and participant;
3. validates message structure and limits;
4. checks idempotency by message ID / sender sequence;
5. allocates the next relationship `server_seq` only for genuinely new messages;
6. inserts the immutable mailbox row transactionally;
7. returns the accepted server sequence.

A retry of the same message returns the original acceptance result.

### Message ordering

For a single sender:

```text
sender_seq 1 -> 2 -> 3
```

must always remain in that order, regardless of retries or server receipt timing.

For messages created independently by both participants while disconnected, there is no truthful way to claim a globally known creation order. The server can provide a deterministic **receipt order** using `server_seq`.

Recommended client history policy:

- preserve per-sender `sender_seq` order as a hard invariant;
- use `server_seq` as the deterministic tie-break/order for cross-sender messages once they have entered the mailbox;
- retain `clientCreatedAt` for display/debugging only;
- do not silently rewrite previously persisted local history merely because a server timestamp arrives later.

If a future product requirement needs true causal ordering, introduce a Lamport/HLC-style logical clock or an established messaging protocol rather than retrofitting timestamp sorting.

### Pull

`GET /v1/sync/pull?after=<serverSeq>&limit=<n>`

Return a bounded batch of mailbox messages after the recipient's last successfully processed server sequence.

Never return an unbounded history or rely on HTTP request size as the queue mechanism.

The recipient:

1. downloads/persists required media;
2. validates/decrypts the message;
3. inserts the message into local SQLite transactionally;
4. updates local active/history state according to the existing domain rules;
5. commits local SQLite;
6. only then sends an ACK.

### ACK

`POST /v1/sync/ack`

```json
{
  "messageIds": ["...", "..."]
}
```

The server records the acknowledgement idempotently.

ACK does **not** mean:
- read;
- seen;
- displayed;
- notification delivered.

It means only that the recipient has durably persisted the item locally.

### Server deletion

A mailbox message may be deleted only when its recipient has acknowledged it.

If a message references media, the media object must not be deleted before the corresponding media is durably available locally and the message is acknowledged.

A cleanup pass may delete stale/unacknowledged data only after a separately chosen maximum retention period. That is a safety policy and must be explicit: if the recipient has been offline longer than the mailbox retention window, the server cannot satisfy the "receive eventually" guarantee.

---

## 8. R2 media design

### Object layout

Use opaque keys; never put names or message plaintext in object keys.

Recommended:

```text
mailbox/<relationship-id>/<message-id>/<random-object-id>
```

The relationship/message IDs are UUID-like opaque identifiers. If E2E privacy is strengthened later, relationship IDs can themselves be opaque random values unrelated to user-visible information.

### Upload flow

1. Client authenticates to Worker.
2. Client requests an upload slot:
   `POST /v1/media/uploads`
3. Worker validates declared type and size against server policy.
4. Worker creates `media_objects` metadata in D1.
5. Worker returns a short-lived presigned R2 PUT URL.
6. Client uploads directly to R2.
7. Client calls `POST /v1/media/uploads/<id>/complete`.
8. Worker checks object existence/metadata and marks the media complete.
9. Client can now push the encrypted message referencing the media object.

Do not consider a D1 media record alone sufficient: the object must actually exist before the message becomes deliverable.

### Download flow

1. Recipient pulls a mailbox message and sees a media ID.
2. Recipient requests a short-lived GET URL from the Worker.
3. Worker verifies that the authenticated device is the intended relationship participant and that the object belongs to an unexpired mailbox message.
4. Worker returns a short-lived R2 GET presigned URL.
5. Client downloads directly from R2 and persists it locally.
6. Client ACKs the message only after local persistence succeeds.

Presigned URLs are bearer tokens. Keep their lifetime short (for example 5–15 minutes for normal media) and never expose them in logs.

### MIME validation

Do not trust a client-provided MIME type as proof of content type. The Worker can constrain the signed Content-Type, but a malicious client can still construct valid bytes with an allowed MIME label.

For a first implementation:
- whitelist supported MIME families;
- enforce a server-side byte limit;
- record declared MIME and size;
- reject unknown types;
- optionally validate magic bytes for common image/video formats;
- keep media E2E-encrypted if privacy is the goal.

Deep media inspection/transcoding is intentionally out of scope for the mailbox.

### Size and resumability

R2 single PUT is suitable for small/medium media. Cloudflare currently recommends multipart uploads for large files and specifically calls out video/reliability use cases. Multipart uploads support up to 10,000 parts and are resumable.

Recommendation:
- single PUT for normal photos and small videos;
- multipart for larger videos above a chosen client threshold (for example 100 MB, subject to actual mobile UX testing);
- choose the threshold based on observed failure rates rather than theoretical limits.

### Proxying through Workers

Do **not** proxy normal media through Workers. The Worker should authorize and sign; R2 should carry the bytes.

Proxying would add latency, memory/streaming complexity, request-body limits, and unnecessary Worker execution.

### Lifecycle

Configure an R2 lifecycle rule as a **safety net**, not as the primary delivery mechanism. For example, stale mailbox media can expire after a deliberately generous maximum retention period.

Cloudflare's lifecycle engine typically removes expired objects within 24 hours, so lifecycle deletion is not suitable for precise per-message ACK semantics.

The Worker should delete acknowledged media promptly; lifecycle handles orphaned/stuck objects.

Incomplete multipart uploads already have a default seven-day abort behavior; retain/configure this deliberately.

---

## 9. Security / threat model

### Threats

Assume:
- an attacker can observe/share a deep link accidentally;
- an attacker can brute-force public endpoints;
- a device token can be stolen from a compromised phone;
- an attacker can retry requests and replay HTTP bodies;
- clients can be malicious and lie about MIME types/sizes;
- clients can submit malformed encrypted payloads;
- an R2 presigned URL can leak;
- Cloudflare/platform operators can observe server-side metadata and any plaintext that the protocol accidentally sends;
- the server can be compromised.

### Defenses

**Authentication**
- 32-byte+ random device token.
- Store only a hash server-side.
- Support revocation.
- HTTPS only.

**Pairing**
- 32-byte+ random invitation token.
- 24-hour expiration target.
- One-time consumption in one D1 transaction.
- Human code is not the credential.
- Rate-limit invitation creation/acceptance/code checks.

**Authorization**
- Every resource access derives the relationship from the authenticated device.
- Never trust a client-supplied `relationshipId` without checking membership.
- Never allow one participant to request another relationship's object/message.

**Replay/idempotency**
- Unique message ID.
- Unique sender sequence.
- Unique invitation token.
- Idempotent ACKs.
- Presigned URL expiration.

**Abuse limits**
- Rate-limit pairing endpoints by IP and invitation identifier.
- Rate-limit authenticated sync by device and relationship.
- Bound push batch size.
- Bound message ciphertext size.
- Bound number and size of media uploads per relationship.
- Limit active incomplete media uploads.
- Return generic pairing errors where useful to avoid invitation enumeration.

Workers Rate Limiting API can provide application-level path/resource limits. Cloudflare WAF/rate limiting can add perimeter protection later if the endpoint becomes public at meaningful scale.

**Logging/privacy**
- Never log bearer tokens, invitation tokens, presigned URLs, ciphertext, or message bodies.
- Prefer opaque IDs and aggregate operational metrics.
- Avoid logging full request bodies.

---

## 10. E2E encryption considerations

E2E must influence the schema now even though it is not implemented now.

### Server-visible envelope

The mailbox should eventually contain something conceptually like:

```text
message_id
sender_device_id
sender_seq
server_seq
ciphertext
ciphertext_version
media_id
```

The server should not need:

```text
plaintext body
emoji
photo contents
video contents
encryption keys
```

### Do not invent cryptography

When E2E is implemented, use an established protocol/library appropriate to the actual platform and threat model. Do not invent a custom key exchange or "encrypt with a shared secret" protocol inside the Worker.

### Media encryption

If Rucola promises E2E privacy, media must be encrypted **before** upload. R2 should receive ciphertext bytes. The Worker should not be required to inspect the photo/video contents.

The application may still send non-secret metadata such as byte size, object type, and sequence information.

### Device identity vs encryption identity

Do not assume the HTTP bearer credential is an encryption key. Keep these concepts separate:

- transport/authentication credential;
- device identity;
- relationship cryptographic identity;
- message/media encryption keys.

This makes credential rotation/revocation possible without rewriting encrypted history.

### Future device replacement

Device reinstall/recovery is explicitly future work. Do not design the current server protocol as though a lost device can simply authenticate as the old device. Recovery requires a separate key-management decision.

---

## 11. Failure and edge-case analysis

### Sender sends A/B/C while recipient is offline

Server receives A/B/C and assigns increasing `server_seq` values. Recipient pulls all three. Local SQLite commits all three in order. C becomes active; A/B remain history. ACKs are sent after durable local persistence.

**Required test:** interrupt sync after A and B but before C; retry; no duplicate A/B and C eventually arrives.

### Same POST retried after timeout

Client retries with the same `messageId` and `senderSeq`. Server finds the existing unique record and returns the existing result.

No duplicate mailbox item.

### Two devices send concurrently

D1 serializes the actual insert/sequence allocation. One gets the lower `server_seq`, the other the next. Neither timestamp nor Worker execution start time is used as the sole ordering rule.

### Recipient pulls but crashes before local commit

No ACK. Server retains the message. Recipient retries and persists it.

### Recipient commits locally but ACK request fails

Message remains on server. Recipient retries ACK. ACK is idempotent. Server eventually deletes the temporary copy.

### Media download succeeds but local media persistence fails

No message ACK. Retry media download. Server keeps message and media.

### Media upload succeeds but message upload fails

The object is orphaned temporarily. D1 media metadata/expiry plus R2 lifecycle cleanup eventually removes it. A later retry can reuse the same media ID if the protocol permits, otherwise the client requests a new upload slot.

### Corrupted encrypted payload

Server stores opaque ciphertext but validates structural limits. Recipient detects decryption/authentication failure and does **not** acknowledge the message. The protocol needs an explicit permanent-invalid state/repair UX rather than silently dropping it.

A malformed message must not poison the whole mailbox forever; bounded pull batches and a dead-letter/error state should be considered during implementation.

### Sender device clock is wrong

`client_created_at` may be nonsense. It must never control server queue order.

### Sender sends while server is unavailable

Local message remains `PENDING`/equivalent. The user can continue creating messages. Sync retries later.

### Server unavailable after local history is created

No loss. Local SQLite remains authoritative.

### Device reinstall

The new install is a new anonymous device unless a future recovery protocol exists. It cannot automatically retrieve permanent history from the mailbox because the server is not the archive.

### Relationship ended while messages are pending

The server should stop accepting new messages and retain local history. Pending mailbox messages need an explicit policy: either drain already accepted messages during a grace period or expire them. Do not silently delete local history.

### Invitation expires during acceptance

The acceptance transaction checks expiry at the server and either consumes the invitation atomically or rejects it. Client clock is irrelevant.

### Invitation accepted twice concurrently

A unique/conditional update must ensure only one request consumes it. The losing request receives a non-success result.

### Same human code appears in another invitation

Possible and acceptable if the code is treated only as a human confirmation aid. Never authorize pairing from the code alone.

---

## 12. API surface

Keep the first backend small:

```text
POST /v1/pair/invitations
POST /v1/pair/accept
POST /v1/pair/confirm        (optional; only if UX needs a second confirmation step)

POST /v1/sync/push
GET  /v1/sync/pull
POST /v1/sync/ack

POST /v1/media/uploads
POST /v1/media/uploads/:id/complete
GET  /v1/media/:id/download

GET  /v1/relationship
POST /v1/relationship/end
```

Do not add:
- websocket chat;
- generic CRUD for messages;
- message editing/deletion;
- server-side history search;
- public profiles;
- comments/reactions;
- generic user accounts.

The API should be a mailbox protocol, not a social API.

---

## 13. Retention model

There are two different retention mechanisms:

### Normal retention

Delete a mailbox message after recipient ACK.

Delete its temporary media after the corresponding message/media has been durably acknowledged.

This is the normal fast path.

### Safety retention

Set an explicit maximum mailbox lifetime (exact value still requires product approval). For example, a message could be retained for several weeks even if the recipient never connects, after which the server expires it.

This is necessary because "server is a temporary mailbox" and "recipient may be offline for weeks" are otherwise contradictory if the server has no upper bound.

The product must decide whether expiration means:
- silently dropping the server copy;
- surfacing a synchronization-loss state;
- or some future recovery mechanism.

R2 lifecycle is a backstop, not the source of truth for message retention.

---

## 14. Cleanup / operations

Use a Worker Cron Trigger for periodic cleanup. Cron runs in UTC and is suitable for maintenance tasks.

A cleanup run should process bounded batches:

1. delete acknowledged mailbox rows older than a short grace period;
2. delete acknowledged media metadata and R2 objects;
3. mark/remove expired invitations;
4. remove abandoned media-upload metadata;
5. optionally report metrics for stale unacknowledged mail.

Never scan/delete the entire mailbox in one invocation.

R2 lifecycle rules independently expire stale objects after the maximum safety window.

### Observability

Track only operational metrics that do not expose content:
- request counts/statuses;
- sync batch sizes;
- mailbox age/size;
- media byte totals;
- ACK latency;
- expired invitation counts;
- upload failures;
- rate-limit events.

Do not log message plaintext, encryption keys, bearer tokens, invitation tokens, or presigned URLs.

---

## 15. Deployment plan

When implementation begins:

```text
cloud/
  worker/
    src/
    migrations/
    wrangler.toml
    package.json
  README.md
```

Keep backend code separate from the mobile app rather than adding Worker code under the React Native source tree.

Recommended environments:

- local development D1/R2 resources;
- one staging Worker/database/bucket;
- production Worker/database/bucket.

Secrets/credentials belong in Cloudflare Worker secrets, not git.

CI should eventually:

1. install Worker dependencies;
2. typecheck;
3. run unit tests;
4. run D1 integration tests against a local/miniflare-style environment where practical;
5. deploy only from an intentional release workflow.

Do not make mobile CI depend on production cloud credentials.

---

## 16. Local model changes that will eventually be needed

The current local model is close, but cloud sync will be difficult without a few additions.

### A. `orderIndex` is not sufficient

Current `orderIndex` is a local relationship-wide counter. It is useful for current local history but cannot represent distributed ordering safely.

Eventually add explicit sync metadata such as:

```text
messageId
senderDeviceId
senderSeq
clientCreatedAt
serverSeq (nullable until synchronized)
```

Do not replace `orderIndex` blindly; it may remain as a local presentation/cache field during migration.

### B. `syncState` is too coarse

`LOCAL_ONLY | PENDING | SYNCED | FAILED` is a useful start but cannot express media-upload state, ACK state, or permanent validation failures.

Prefer separate concepts later:

```text
outboundSyncState
mediaSyncState
remoteAcknowledged
lastSyncError
```

Avoid turning this into a huge state machine unless actual behavior requires it.

### C. Device identity is currently absent from the domain model

The local database needs a stable anonymous device ID and eventually a secure credential/token storage strategy. The device ID must survive normal app restarts and be distinct from the server bearer credential.

### D. Participant is not enough for future multi-device support

Today `ME | PARTNER` is exactly what the product wants. Future sync should still identify the originating device separately so two devices for one participant cannot accidentally reuse the same sender sequence.

### E. Media references are currently local paths

`mediaReference` is an app-owned local file reference today. That is correct for offline-first storage but cannot be used as the remote R2 identity.

Eventually separate:

```text
localMediaReference
remoteMediaId
remoteUploadState
```

Do not overwrite the local path with a URL.

### F. Incoming-message persistence API is not present

The current repository has a local `sendMessage` path but no explicit domain-level `applyIncomingSyncedMessage` / `acknowledgeRemotePersistence` boundary. Add that only when sync implementation begins, so the sync engine can persist incoming messages without pretending the UI sent them.

### G. Active-message replacement must remain transactional

The cloud sync implementation must reuse the same domain invariant: receiving A/B/C must insert all three, archive prior active messages, and leave C active. It must never treat "latest downloaded" as permission to discard earlier messages.

---

## 17. Recommended implementation sequence

Do not start with push notifications or realtime transport.

### Phase 1 — protocol/schema lock

- Agree on device identity and pairing semantics.
- Agree on message IDs and sender sequences.
- Add the future sync fields to a protocol document, not necessarily app code.
- Decide maximum mailbox/media retention.

### Phase 2 — backend skeleton

- Worker project.
- D1 migrations.
- Health endpoint.
- Authentication middleware.
- Pairing endpoints.

### Phase 3 — text/emoji mailbox

- Push.
- Pull.
- Local incoming-message application.
- ACK.
- Retry/idempotency tests.

### Phase 4 — media mailbox

- R2 bucket.
- Presigned upload/download.
- Media completion handshake.
- Cleanup/lifecycle.
- Large-video/multipart path if needed.

### Phase 5 — adversarial sync testing

Test:
- offline A/B/C;
- simultaneous sends;
- duplicate push;
- duplicate ACK;
- crash before/after local commit;
- crash during media download;
- invitation replay;
- invitation expiry race;
- malformed payloads;
- device revocation;
- relationship end;
- server downtime;
- very old mailbox entries.

### Phase 6 — push/background sync

Only after foreground sync is correct. Push is a wake-up hint, not the synchronization protocol.

### Phase 7 — E2E encryption

Use an established protocol/library and migrate the already-defined opaque mailbox envelope to encrypted payloads.

---

## 18. Open decisions requiring Nico's approval

1. **Maximum mailbox retention:** how long should the server retain an unacknowledged message/media item? This determines what happens if a phone is offline for longer than that period.
2. **Manual pairing:** should the cute human code ever be sufficient to complete pairing, or must the secure token always travel through a deep link/QR/share flow? Recommendation: secure token required.
3. **One device per participant:** keep this restriction initially, or design multi-device support now? Recommendation: one active device per participant for MVP, but keep `device_id` separate from participant so expansion is possible.
4. **Cross-participant ordering:** accept server receipt order (`server_seq`) as the deterministic total order, while preserving per-sender order; or introduce a causal/logical-clock scheme. Recommendation: server order for the first protocol.
5. **Mailbox expiry UX:** silently expire unreachable server copies, or surface a sync failure to the user after retention expires?
6. **Media limits:** maximum photo size, maximum video size, and whether large videos justify multipart upload in the first cloud release.
7. **E2E protocol:** which established protocol/library should be used once encryption work starts. This should be researched separately against Expo/RN platform constraints rather than inventing crypto.
8. **Cloudflare plan:** Free is sufficient for development, but production should probably use a paid Workers plan if the service is meant to be dependable and not subject to free-tier daily write/read exhaustion.

---

## 19. Final assessment

**D1 is appropriate for Rucola.** It is not being chosen as a high-scale messaging database; it is being chosen as a tiny transactional mailbox database whose workload is naturally small and relationship-scoped.

The biggest risks are not D1 or R2. They are protocol mistakes:

- using timestamps as message order;
- treating server receipt order as creation order without documenting the distinction;
- making the server authoritative for history;
- deleting before durable local acknowledgement;
- conflating sync/delivery with read state;
- making the human pairing code a password;
- proxying large media through the Worker;
- designing the payload as plaintext and discovering E2E requirements later.

Avoid those mistakes and the proposed Cloudflare stack remains simple, cheap, and auditable.

---

## Sources / validation references

Primary Cloudflare documentation reviewed September 2026:

- D1 overview: https://developers.cloudflare.com/d1/
- D1 limits/concurrency: https://developers.cloudflare.com/d1/platform/limits/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 Worker Binding API / batch / sessions: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 foreign keys: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- D1 read replication / Sessions: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers Rate Limiting API: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Workers Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 upload methods / multipart: https://developers.cloudflare.com/r2/objects/upload-objects/
- R2 limits: https://developers.cloudflare.com/r2/platform/limits/
- R2 lifecycle: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/

These links should be rechecked when implementation starts because Cloudflare limits, pricing, and APIs can change.
