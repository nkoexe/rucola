# Cloud Sync Hardening

This document records security and correctness findings from the cloud synchronization audit. Current protocol behavior belongs in `docs/CLOUD_ARCHITECTURE.md`; this file explains the hardening work and the remaining decisions.

## Current status

### Complete

- cryptographic pairing token generation and hashed invitation material
- bounded confirmation-code attempts and lockout
- device-bound authentication
- durable message receipts
- database-enforced message acceptance sequence invariant
- database-enforced media attachment invariant
- database-enforced media/message type compatibility
- concurrent ACK hardening
- relationship termination guards for pull and ACK
- expiry/cursor-gap coverage
- sender-device binding for legacy mailbox retry classification

### Pending

- sender retry guarantee and receipt retention window
- final media upload/completion API
- R2 integration
- media cleanup policy and scheduled cleanup
- obsolete `mailbox_messages.acknowledged_at` removal after protocol confirmation
- production migration/backfill policy for pre-receipt mailbox data
- final full worker validation after the remaining protocol work

## Durable message receipts

The mailbox is intentionally temporary, but message identity must survive mailbox deletion long enough to make sender retries safe. `message_receipts` therefore stores synchronization metadata plus a SHA-256 digest of opaque ciphertext.

It preserves:

- relationship + message identity
- sender device + sender sequence
- immutable message metadata
- ciphertext digest
- original server sequence and acceptance timestamp

Push acceptance creates the receipt and mailbox row in the same D1 transaction. A retry after mailbox ACK can therefore recover the original server sequence without creating a duplicate message.

Receipt cleanup is intentionally blocked until the sender retry guarantee is explicitly defined.

## Database acceptance invariants

Critical acceptance invariants are enforced at the SQLite boundary:

- inserting a mailbox row must advance `relationships.next_server_seq` exactly once;
- a media-backed mailbox row must consume the referenced `READY` upload and mark it `ATTACHED`;
- `PHOTO_VIDEO` must reference compatible media;
- other message types must not reference media;
- failures abort the insertion and roll back the transaction.

This prevents application-level success from diverging from database state if an expected state transition affects zero rows.

## Pull authorization

Mailbox pull checks relationship state through a sequentially consistent D1 session and requires an ACTIVE relationship in the mailbox query. A terminated relationship therefore cannot continue normal mailbox reads.

## ACK lifecycle

ACK validation and destructive deletion use the same D1 session. The DELETE independently requires an ACTIVE relationship, preventing an ACK from deleting mailbox data after termination.

Repeated ACKs are idempotent. Concurrent ACKs are tested so their combined deletion cannot exceed the requested high-water mark.

ACK is the recipient's durability boundary: the client must persist messages locally before acknowledging them. For media messages, the referenced media must also be locally durable.

## Cursor and expiry semantics

Expired mailbox rows are skipped rather than returned as tombstones. Server sequence cursors are therefore high-water marks, not contiguous retained-row counts.

A client must tolerate gaps and advance using the highest returned server sequence only after local persistence.

## Media lifecycle

The current media lifecycle contract is documented separately in `docs/MEDIA_LIFECYCLE.md`.

The important invariant is that mailbox pull and ACK are not media deletion events. Media cleanup must follow the sender retry and recipient durability guarantees and must be safe to retry after crashes.

## Migration/backfill note

Durable receipts were introduced after the initial mailbox schema. Existing pre-migration mailbox rows do not have receipts. The push path therefore retains a legacy mailbox conflict check while such rows remain.

Production deployment must either occur before real mailbox data exists or define an explicit backfill strategy.

## Obsolete state

`mailbox_messages.acknowledged_at` remains in the schema for now, although the current ACK implementation deletes acknowledged rows immediately. It should be removed only after the protocol and migration history no longer require it.

## Audit principle

Cloud correctness is defined by the local durability contract, not by whether an HTTP request returned successfully. A request may commit before its response reaches the client, so every mutation must have an idempotent retry path or an explicit one-time/expiry rule.
