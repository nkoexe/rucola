# Cloud Sync Hardening

## Phase 3 findings

The mailbox is intentionally temporary, but message identity must survive mailbox deletion long enough to make sender retries safe. `mailbox_messages` therefore cannot be the only idempotency source.

### Durable message receipts

Migration `0002_message_receipts.sql` adds `message_receipts` containing only synchronization metadata and a SHA-256 digest of the opaque ciphertext. It does not retain plaintext or a second ciphertext copy.

The receipt preserves:

- relationship + message identity
- sender device + sender sequence
- immutable message metadata
- ciphertext digest
- original server sequence and acceptance timestamp

Push acceptance creates the receipt and mailbox row in the same D1 batch, with the mailbox row as the acceptance source of truth. The receipt remains after mailbox ACK cleanup, so a lost push response can be retried without allocating another server sequence.

### Database acceptance invariants

Migration `0003_message_acceptance_invariants.sql` moves the critical acceptance invariants into SQLite:

- inserting a mailbox row must advance `relationships.next_server_seq` exactly once
- a media-backed mailbox row must consume the referenced `READY` upload and mark it `ATTACHED`
- either failure aborts the mailbox insert and rolls back the batch

This prevents application-level success from diverging from database state if a later statement unexpectedly affects zero rows.

### Pull authorization hardening

Mailbox pull checks relationship state through a `first-primary` D1 session and joins the mailbox query against an ACTIVE relationship. This prevents a request from returning mailbox data after the relationship has become inactive.

### ACK lifecycle hardening

ACK validation and deletion use the same D1 session, and the destructive DELETE independently requires the relationship to remain `ACTIVE`. This prevents an ACK from deleting mailbox data after relationship termination.

Repeated ACKs remain idempotent. Concurrent ACKs are tested to ensure their combined deletion count cannot exceed the acknowledged high-water mark.

### Cursor and expiry semantics

Expired mailbox rows are intentionally skipped rather than returned as tombstones. Server sequence cursors are therefore high-water marks, not contiguous mailbox-row counts. A client can safely advance from an expired sequence to a later live sequence.

ACK is a destructive durability boundary: the client must only ACK after all messages through the requested server sequence have been durably persisted locally.

### Privacy / retention decision

Receipts deliberately contain a digest rather than ciphertext. They are synchronization metadata, not cloud message history.

Receipt retention/cleanup is still deliberately unresolved. A production policy must define the maximum sender retry window before implementing cleanup. This decision also needs to be coordinated with `media_uploads`, because durable receipts currently retain their media-upload relationship through a foreign key.

### Migration note

`0002_message_receipts.sql` is being introduced before production deployment. Existing pre-migration mailbox rows do not have receipts; the push implementation retains a legacy mailbox conflict check so existing rows remain idempotent while they are still present. A production migration must either run before any real mailbox data exists or define an explicit backfill strategy.

## Phase 3 status

- acceptance invariants: complete
- concurrent ACK hardening: complete
- relationship termination guards: complete
- expiry/cursor-gap coverage: complete
- durable receipt retention policy: pending
- obsolete `acknowledged_at` removal: pending protocol decision
- final full worker validation: pending after the remaining retention/media decisions

## Next phase

Before R2 implementation, define the media lifecycle around three independent states:

1. upload object exists in R2
2. upload metadata is `PENDING` or `READY` in D1
3. accepted message references the upload and moves it to `ATTACHED`

The media design must make upload completion, message acceptance, mailbox ACK, expiry, and eventual R2 deletion safe under retries and crashes. No media object should be deleted merely because a mailbox row was pulled; deletion must follow the agreed durability boundary.
