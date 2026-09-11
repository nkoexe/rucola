# Rucola Cloud D1 Schema / C2

**Status:** schema and transaction design; no production infrastructure.

**Branch:** `cloud/research`

## 1. C2 outcome

C2 converts the C1 protocol invariants into a concrete relational design for the first backend implementation.

The database remains a **temporary mailbox**, not the permanent message history. The mobile SQLite database remains authoritative for durable local history.

The design intentionally uses one D1 database with short transactions. It does not use Durable Objects, D1 read replication, server-side message editing, or a generic chat CRUD model.

## 2. Core invariants

1. A relationship has exactly two participants in the MVP.
2. A participant has one active device in the MVP; `device_id` is nevertheless distinct from participant identity.
3. A device-generated `message_id` is stable across retries.
4. `(sender_device_id, sender_seq)` identifies one logical outbound message within a relationship.
5. A sender sequence may contain gaps because requests may arrive out of order. The server does not require contiguous arrival.
6. Reusing a sender sequence for a different message is a protocol conflict.
7. `server_seq` is monotonically allocated per relationship for genuinely new mailbox messages only.
8. `server_seq` is receipt/acceptance order, not creation order.
9. Mailbox messages are immutable. Only delivery/retention metadata changes.
10. A message is not inserted if a referenced media upload is not complete and authorized for that relationship/device.
11. ACK is idempotent and means durable recipient persistence, not read/seen.
12. A message is eligible for normal mailbox deletion only after recipient ACK.
13. Expiry is a safety boundary for unacknowledged mailbox data; it is not a guarantee of indefinite delivery.
14. Invitation token consumption and second-device creation happen atomically.
15. Security credentials are stored as hashes, never plaintext.
16. E2E ciphertext is opaque to the schema; no plaintext message body is required by the backend.

## 3. Tables

### `relationships`

```sql
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PAIRING', 'ACTIVE', 'ENDED')),
  next_server_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_server_seq >= 1),
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

`next_server_seq` is the next unused per-relationship mailbox sequence. It is incremented in the same transaction that inserts a genuinely new message.

A sequence value is never reused, including after deletion or relationship end.

The counter is intentionally stored on the relationship rather than derived with `MAX(server_seq)+1`; this avoids race-prone read/compute/write logic and keeps allocation explicit.

### `devices`

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX devices_active_participant
  ON devices(relationship_id, participant)
  WHERE revoked_at IS NULL;

CREATE INDEX devices_relationship
  ON devices(relationship_id);
```

The partial unique index enforces one active device per participant in the MVP while allowing revoked historical device rows to remain auditable.

Do not use a client-supplied participant value as authorization. The authenticated device record is the source of truth.

A future multi-device migration can remove/replace the partial uniqueness constraint without changing message identity semantics.

### `invitations`

```sql
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  confirmation_code_hash TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_device_id TEXT,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (consumed_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL AND consumed_by_device_id IS NULL)
      OR (consumed_at IS NOT NULL AND consumed_by_device_id IS NOT NULL))
);

CREATE INDEX invitations_expiry
  ON invitations(expires_at);
```

The secure invitation token is a high-entropy credential. The human confirmation code is not sufficient for authentication.

The acceptance transaction must check `consumed_at IS NULL` and `expires_at > now`, create the second device, update the invitation, and activate the relationship as one transaction.

### `media_uploads`

Media intentionally has its own pre-message lifecycle.

```sql
CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('PHOTO', 'VIDEO', 'DRAWING')),
  declared_mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  checksum TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'ATTACHED', 'ABANDONED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  attached_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((status = 'PENDING' AND completed_at IS NULL AND attached_at IS NULL)
      OR (status = 'READY' AND completed_at IS NOT NULL AND attached_at IS NULL)
      OR (status = 'ATTACHED' AND completed_at IS NOT NULL AND attached_at IS NOT NULL)
      OR (status = 'ABANDONED'))
);

CREATE INDEX media_uploads_expiry
  ON media_uploads(expires_at);

CREATE INDEX media_uploads_relationship
  ON media_uploads(relationship_id, created_at);
```

The Worker creates a `PENDING` row before issuing a presigned upload URL. After verifying the object exists, it changes the row to `READY`. Message push may then atomically transition it to `ATTACHED` while inserting the mailbox message.

The schema deliberately does not require a mailbox-message foreign key from `media_uploads` because the upload exists before the message. `mailbox_messages.media_upload_id` is the one-way relationship from an accepted message to its media upload.

One media upload can be attached to at most one message because `mailbox_messages.media_upload_id` is UNIQUE.

### `mailbox_messages`

```sql
CREATE TABLE mailbox_messages (
  relationship_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  sender_participant TEXT NOT NULL CHECK (sender_participant IN ('ME', 'PARTNER')),
  sender_seq INTEGER NOT NULL CHECK (sender_seq >= 1),
  client_created_at INTEGER NOT NULL,
  server_seq INTEGER NOT NULL CHECK (server_seq >= 1),
  server_received_at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')),
  ciphertext BLOB NOT NULL,
  encryption_version INTEGER NOT NULL,
  media_upload_id TEXT,
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (media_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT,
  PRIMARY KEY (relationship_id, message_id),
  UNIQUE (relationship_id, sender_device_id, sender_seq),
  UNIQUE (relationship_id, server_seq),
  UNIQUE (media_upload_id),
  CHECK (expires_at > server_received_at),
  CHECK ((acknowledged_at IS NULL) OR (acknowledged_at >= server_received_at))
);

CREATE INDEX mailbox_pull
  ON mailbox_messages(relationship_id, server_seq);

CREATE INDEX mailbox_expiry
  ON mailbox_messages(expires_at);

CREATE INDEX mailbox_ack_cleanup
  ON mailbox_messages(relationship_id, acknowledged_at);

CREATE INDEX mailbox_sender_sequence
  ON mailbox_messages(relationship_id, sender_device_id, sender_seq);
```

`sender_participant` is copied at acceptance time for immutable audit/debug information. The server must verify it matches the authenticated sender device before insertion.

The payload is already represented as `ciphertext` so the backend does not need to be redesigned when E2E is enabled. `encryption_version` identifies the envelope/protocol version, not a cryptographic key.

`acknowledged_at` is sufficient for the MVP because there is exactly one active recipient device per participant. A future multi-device design should replace this with per-recipient acknowledgement state rather than pretending one ACK covers every device.

## 4. Why there is no separate ACK table in MVP

The earlier design considered `mailbox_acks`. For the current one-device-per-participant model, that is unnecessary complexity.

Each mailbox message has exactly one intended recipient: the other participant's active device. Therefore `acknowledged_at` directly represents that delivery state.

This also avoids a deletion problem where an ACK row would hold a foreign key to a mailbox message that the cleanup job wants to delete.

If multi-device support becomes a real requirement, introduce a separate acknowledgement table in a migration rather than prematurely designing for it.

## 5. Message push transaction

Before the transaction:

- authenticate the bearer credential;
- load the authenticated device;
- verify it is active;
- verify relationship is ACTIVE;
- validate payload size/type/encryption envelope;
- if media is referenced, verify the upload belongs to the same relationship/device and is `READY` and unexpired.

Inside one D1 transaction:

1. Look up `(relationship_id, message_id)`.
2. If it exists, compare immutable fields. If identical, return the existing `server_seq` idempotently. If different, return a conflict.
3. Look up `(relationship_id, sender_device_id, sender_seq)`.
4. If that sequence already belongs to another `message_id`, return a protocol conflict.
5. Read `next_server_seq` from `relationships`.
6. Insert the mailbox row with that `server_seq`.
7. Increment `relationships.next_server_seq` by one.
8. If media is present, change its status from `READY` to `ATTACHED` with `attached_at`.
9. Commit.

The sequence increment and message insert must succeed or fail together.

Do not make an R2 call inside this transaction.

## 6. Duplicate push semantics

There are three important cases.

### Exact retry

Same `message_id`, same sender sequence, same immutable payload metadata:

**Result:** return the original acceptance. Do not allocate another `server_seq`.

### Same message ID, changed payload

**Result:** conflict. Never mutate the stored message to match the retry.

### Same sender sequence, different message ID

**Result:** protocol conflict. This means the sender's local sequence discipline has broken or two logical messages accidentally share a sequence.

The client should generate a new sequence rather than trying to overwrite the server's existing message.

## 7. Pull transaction / cursor semantics

The server pull API is cursor-based:

```text
GET /v1/sync/pull?after=<last_durable_server_seq>&limit=<bounded-limit>
```

The server returns messages with `server_seq > after`, ordered ascending by `server_seq`.

The mobile client must not persist the cursor independently of the message transaction.

Conceptually the local transaction is:

```text
BEGIN
  apply incoming messages
  advance local durable sync cursor
COMMIT
```

If the transaction fails, the cursor does not advance and the same mailbox messages are safe to pull again.

The server does not need to know the client's cursor as authoritative state.

## 8. ACK transaction

Before ACK:

- authenticate recipient device;
- verify message belongs to its relationship and is addressed to the opposite participant;
- verify the client claims durable local persistence.

Inside D1:

```sql
UPDATE mailbox_messages
SET acknowledged_at = :now
WHERE relationship_id = :relationship
  AND message_id = :message
  AND acknowledged_at IS NULL;
```

A repeated ACK is successful and does nothing.

The server does not interpret ACK as read/seen/displayed.

## 9. Cleanup semantics

Normal cleanup deletes acknowledged messages after a small grace period. The grace period is useful for operational recovery and debugging; its exact value is not part of the delivery protocol.

Before deleting an acknowledged mailbox message with media, cleanup should delete the R2 object and then remove the D1 metadata in a safe/idempotent order. R2 deletion is idempotent from the application perspective.

Expired unacknowledged messages are handled separately. They are not silently treated as successful delivery.

A scheduled cleanup job must use bounded batches and repeat until the next scheduled run rather than attempting an unbounded table scan.

## 10. Media completion and message push race

The intended sequence is:

```text
create media_upload(PENDING)
        |
        v
presigned PUT -> R2
        |
        v
complete upload -> READY
        |
        v
push message + attach media -> ATTACHED + mailbox message
```

If two requests attempt to attach the same media upload, only one can win because the message insert has a UNIQUE `media_upload_id` and the media transition is conditional on `status = READY`.

If the message transaction rolls back, the media row remains `READY` and may be retried.

If the R2 object disappears after `READY` but before message push, the Worker must verify object existence before accepting/attaching the media. The Worker should not rely solely on stale D1 state.

If R2 verification is temporarily unavailable, fail the message push conservatively rather than creating a mailbox message that references unavailable media.

## 11. Pairing transaction

Invitation acceptance is one transaction:

1. Validate token hash and expiry.
2. Verify invitation is unconsumed.
3. Verify relationship is still `PAIRING` and has exactly one active device.
4. Create the second device.
5. Mark invitation consumed with timestamp and device ID.
6. Change relationship to `ACTIVE`.
7. Commit.

Two concurrent accept requests cannot both succeed because the invitation row is conditionally consumed and the active-device uniqueness constraint is a second defense.

Expired invitations are rejected based on server time.

## 12. Relationship creation / first device

Pairing is intentionally modeled as a relationship with one initial device:

```text
create relationship(PAIRING)
create first device
create invitation
```

These operations should be performed in one transaction by the invitation-creation endpoint.

The endpoint must reject invitation creation if the authenticated device is not an active member of the relationship.

Only a `PAIRING` relationship with one active device can accept a second device.

## 13. Relationship end

Ending a relationship is an explicit state transition:

```text
ACTIVE -> ENDED
```

It must atomically stop new message acceptance and record `ended_at`.

Already accepted mailbox messages need a defined policy. For the first implementation, do **not** retroactively delete already accepted messages when the relationship ends. Let normal ACK/retention cleanup handle them, while rejecting new pushes.

A later product decision may add a short post-end drain period if desired.

## 14. Sequence edge cases

### Out-of-order sender requests

Accepting sender sequence 7 before sender sequence 6 is allowed. The server assigns receipt order independently.

This is deliberate: requiring contiguous sequences would make temporary network reordering look like a permanent sender failure.

### Duplicate sequence

The same `(device, sender_seq)` with the same message ID is an idempotent retry. The same pair with another message ID is a conflict.

### Sequence rollback after reinstall

A new installation must get a new `device_id`; it must not reuse the old device's sender sequence namespace without a recovery protocol.

### Integer limits

Use SQLite INTEGER values for sequences. The client should reject/rotate before approaching practical integer exhaustion. This is not a realistic near-term constraint but should be validated rather than relying on silent overflow behavior.

## 15. Retention fields

All server times are server-generated integer timestamps in UTC epoch milliseconds.

The client-provided `client_created_at` is retained only as metadata and is never used for expiry.

`expires_at` on mailbox messages is calculated by the Worker from server receipt time and the configured maximum retention policy.

Media uploads have their own expiry because a client can abandon an upload before a message exists.

The exact maximum retention duration remains a product decision.

## 16. Migration strategy

Do not create the production D1 database yet.

The implementation should begin with numbered SQL migrations, for example:

```text
cloud/worker/migrations/
  0001_initial.sql
```

Future schema changes are additive/migratory and never manually edited in already-applied migration files.

The first migration should create all five tables and all indexes in dependency-safe order:

1. relationships
2. devices
3. invitations
4. media_uploads
5. mailbox_messages

D1 foreign keys should remain enabled.

## 17. Test matrix derived from C1

The schema/transaction implementation must have tests for at least:

- create first device + invitation atomically;
- accept invitation exactly once;
- concurrent invitation acceptance;
- expired invitation;
- revoked inviter;
- push new text/emoji;
- push duplicate exact retry;
- duplicate message ID with changed payload;
- duplicate sender sequence with different message ID;
- sender sequence gaps;
- sender requests arriving out of order;
- server sequence monotonicity;
- server sequence not consumed by duplicate retries;
- media PENDING -> READY;
- failed media completion;
- media READY -> ATTACHED with message push;
- two messages racing for one media upload;
- media object missing after READY;
- pull pagination by server sequence;
- repeated pull after client transaction failure;
- ACK idempotency;
- unauthorized ACK by wrong participant;
- acknowledged message cleanup;
- unacknowledged expiry;
- relationship end blocks new push;
- already accepted messages survive relationship end until normal cleanup;
- revoked device cannot push/pull/ack;
- future encryption-version payload remains opaque to the DB;
- bounded batch limits.

## 18. Decisions intentionally deferred

C2 does **not** silently decide the following product/security choices:

- exact unacknowledged mailbox retention;
- manual code-only pairing;
- exact photo/video byte limits;
- multipart upload threshold;
- poison-message UX and permanent-invalid state;
- final E2E protocol/library;
- future multi-device acknowledgement model;
- relationship-end drain/expiry UX.

These are tracked in `docs/cloud/DECISIONS.md`.

## 19. C2 completion criterion

C2 is complete when the Worker can be implemented from this schema and transaction specification without inventing new identity, ordering, idempotency, or media-lifecycle semantics while coding.
