# Rucola Cloud Decisions

## Current recommendation

- **Worker + D1 + R2** remains the recommended first production architecture.
- D1 is suitable because the mailbox workload is tiny, relational, transactional, and relationship-scoped.
- Do not add Durable Objects unless testing demonstrates a real need for relationship-scoped serialized state beyond what D1 transactions provide.
- R2 should carry media bytes directly; Workers should authorize/sign, not proxy media.
- The server is a temporary mailbox, never the permanent history/archive.
- Message identity comes from the originating device; server acceptance gets a separate per-relationship sequence.
- Timestamps are metadata, not the sole ordering mechanism.
- ACK means durable local persistence, never read/seen.
- Future E2E payloads should be opaque to the Worker and R2.

## Protocol hardening decisions

The adversarial protocol review is complete. The following are now hard invariants for implementation:

- Client-generated `message_id` is stable across retries.
- `sender_seq` is durable per sender device and cannot be reused for a different message.
- `server_seq` is allocated transactionally per relationship and only for genuinely new messages.
- Duplicate push and duplicate ACK operations must be idempotent.
- A push using an already-used sender sequence with a different message ID is a protocol conflict, not a new message.
- The recipient's sync cursor advances only inside the same local SQLite transaction that durably applies the message.
- ACK happens only after that transaction commits and required media is locally durable.
- Media upload is an independent temporary lifecycle before it is attached to a mailbox message; a mailbox-message foreign key cannot be required before the mailbox message exists.
- A mailbox message referencing media is deliverable only after the referenced media upload is complete.
- Invitation consumption and second-device creation happen atomically.
- Pairing token is the credential; the human-friendly code is confirmation/discovery only.
- Auth/device identity is distinct from future E2E encryption identity.
- Mailbox expiry is an explicit delivery boundary, not an implicit guarantee.
- Bounded pull batches and a recoverable poison-message path are required so one invalid message cannot permanently block the mailbox.

## Ordering decisions

- `orderIndex` is a **local SQLite insertion-order value**. It is authoritative only for that phone's local history and is never compared across devices.
- `sender_seq` is the authoritative relative order of messages created by one originating device.
- `server_seq` is the authoritative **mailbox acceptance/delivery order** within a relationship.
- `server_seq` is **not** creation order and is not a claim about the true conversational order of concurrent offline messages.
- A remote message receives the next local `orderIndex` when it is durably inserted. Existing local history is not renumbered because of remote delivery.
- Two phones may therefore have different local insertion orders for concurrently created/offline messages. This is an intentional consequence of preserving append-only local history without inventing a false global creation order.
- Pull remains ascending by `server_seq`; sender-sequence gaps do not block delivery.
- A reinstall creates a new `device_id` and therefore a new sender-sequence namespace. Sequence recovery for an old installation requires a separate recovery protocol.

## Database decisions

- One D1 database is used initially; relationships are rows, not separate databases.
- `relationships.next_server_seq` is the per-relationship mailbox sequence counter. Do not allocate `server_seq` using `MAX()+1`.
- Sender sequences are client-owned and persisted by the originating device. The server permits gaps and out-of-order arrival; it does not require contiguous HTTP arrival.
- `mailbox_messages` uses `(relationship_id, message_id)` as its primary key and additionally enforces unique `(relationship_id, sender_device_id, sender_seq)` and unique `(relationship_id, server_seq)`.
- An exact message retry returns the original acceptance; a reused sender sequence with a different message is a conflict.
- Mailbox messages are immutable. Delivery state is represented by nullable `acknowledged_at` in the MVP.
- A separate ACK table is deliberately deferred until multi-device delivery is actually required.
- Media uses a separate `media_uploads` table because uploads exist before messages. Lifecycle: `PENDING -> READY -> ATTACHED`, with `ABANDONED` for failed/expired uploads.
- `mailbox_messages.media_upload_id` is unique, so one media upload can be attached to only one message.
- Media must be `READY` and still valid when the message transaction attaches it. The Worker must verify the R2 object before accepting the attachment.
- `encryption_version` and opaque `ciphertext` are part of the mailbox schema now so E2E does not require a server data-model rewrite later.
- Server timestamps are authoritative for retention; client timestamps are metadata only.
- Relationship end blocks new message acceptance but does not retroactively erase already accepted mailbox messages.
- One active device per participant is enforced with a partial unique index in the MVP; revoked devices remain as historical records.
- Device credentials and invitation tokens are stored only as hashes.

## Edge-case decisions

- Out-of-order sender sequence arrival is valid; sequence 7 may arrive before 6.
- A new device after reinstall gets a new device identity rather than reusing the old sender-sequence namespace.
- Duplicate media attachment races fail safely through conditional state transition + unique media reference.
- If an R2 object cannot be verified after a media row says `READY`, message acceptance fails conservatively.
- Pull is cursor-based and ascending by `server_seq`; the client cursor is advanced atomically with local SQLite persistence.
- Repeated ACK is a successful no-op.
- Expired unacknowledged mailbox data is not treated as successfully delivered.
- Cleanup is bounded and separate from delivery semantics.

## Pairing contract decisions

- Pairing uses a high-entropy one-time invitation token as the actual credential.
- A human-friendly confirmation code is usability/confirmation material only and cannot authenticate by itself.
- Invitation acceptance atomically creates the second device, consumes the invitation, and transitions `PAIRING -> ACTIVE`.
- Concurrent acceptance of one invitation must result in exactly one successful second-device creation.
- Device credentials and invitation tokens are stored only as hashes.
- The server derives participant identity from authenticated device/relationship state; client-supplied participant or relationship IDs are not authorization inputs.
- Pairing endpoints remain `501` until the contract and adversarial tests are implemented and passing.

## Artifacts

- `docs/cloud/SCHEMA.md` — schema, constraints, transaction boundaries, and test matrix.
- `docs/cloud/MIGRATION_0001.sql` — initial D1 migration draft.
- `docs/cloud/PROTOCOL_REVIEW.md` — adversarial protocol review.
- `docs/cloud/ARCHITECTURE.md` — broader cloud architecture research.
- `docs/cloud/ORDERING.md` — frozen offline/concurrent message ordering model.
- `docs/cloud/PAIRING_PROTOCOL.md` — frozen pairing API and transaction contract plus adversarial test matrix.

## Remaining product decisions

1. Maximum unacknowledged mailbox retention.
2. Exact photo/video size limits and multipart threshold.
3. Poison-message UX and permanent-invalid handling.
4. Eventual E2E protocol/library after Expo/RN compatibility research.
5. Future multi-device acknowledgement model.
6. Relationship-end UX for already accepted/pending mailbox messages.
7. Cloudflare billing/plan choice for production.

## Current implementation boundary

The Worker skeleton and local D1 environment exist, but protocol endpoints remain intentionally inactive. Do not implement mobile sync against them yet.

The next backend implementation step is pairing: implement the frozen contract, add executable transaction/concurrency tests, perform another code review, and only then proceed to message synchronization.
