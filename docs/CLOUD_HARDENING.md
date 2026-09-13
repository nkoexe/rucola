# Cloud Sync Hardening

This document records security, correctness and operational hardening for the production cloud synchronization backend. Current protocol behavior belongs in `docs/CLOUD_ARCHITECTURE.md`; this file tracks hardening status and remaining implementation work.

## Current status

### Complete

- cryptographic pairing token generation and hashed invitation material
- bounded confirmation-code attempts and lockout
- device-bound authentication
- durable message receipts
- explicit receipt delivery/ACK state
- database-enforced message acceptance sequence invariant
- database-enforced media attachment invariant
- database-enforced media/message type compatibility
- concurrent ACK hardening
- relationship termination guards for pull and ACK
- expiry/cursor-gap coverage
- sender-device binding for legacy mailbox retry classification

### Locked decisions

#### Finite retry guarantee

The production cloud deliberately has finite retention:

- unacknowledged mailbox messages: **14-day delivery/retry window**;
- acknowledged durable message receipts: **30 days after acceptance**;
- no indefinite message-idempotency guarantee.

An unacknowledged receipt records the mailbox delivery expiry and becomes a retry-expired tombstone after that point. It must not silently resurrect an expired mailbox message as a new acceptance.

Cleanup must not remove state before the corresponding guarantee expires.

#### Media limits

Initial production transport limits are:

- images: **20 MB**;
- videos: **100 MB**.

Cropping, rounded corners, 4:3/1:1 framing and other presentation behavior are client UI concerns.

#### E2E encryption timing

The backend currently operates on opaque payloads and deliberately does not finalize the cryptographic protocol. Synchronization, media and retry semantics are stabilized first; the final E2E layer is added afterward.

#### Production posture

`cloud/research` is the implementation branch for the actual production backend. Hardening therefore includes operational concerns rather than only prototype correctness: abuse/rate limiting, observability, migration safety, secret handling, cleanup/recovery and bounded resource usage.

## Remaining implementation / hardening

- final media upload/completion API;
- R2 integration;
- scheduled receipt/media cleanup;
- production rate limits beyond pairing bootstrap;
- operational metrics and structured error visibility;
- migration/backfill policy for pre-receipt mailbox data;
- obsolete `mailbox_messages.acknowledged_at` removal after protocol confirmation;
- legacy `sync.ts` removal once the durable path is fully validated;
- final full worker validation after media/R2 implementation.

## Durable message receipts

The mailbox is intentionally temporary, but message identity must survive mailbox deletion long enough to make sender retries safe. `message_receipts` stores synchronization metadata plus a SHA-256 digest of opaque ciphertext.

It preserves relationship/message identity, sender device/sequence, immutable message metadata, ciphertext digest, the original server sequence and acceptance timestamp, plus:

- `delivery_expires_at` — the end of the 14-day mailbox delivery guarantee;
- `acknowledged_at` — set atomically with mailbox deletion when the recipient crosses the durability boundary;
- `retention_expires_at` — the end of the 30-day post-acceptance receipt retention period.

Push acceptance creates the receipt and mailbox row in the same D1 transaction. A retry while delivery is still possible returns the original server sequence. A retry after an unacknowledged delivery window has expired returns `MESSAGE_RETRY_EXPIRED` rather than creating a second acceptance. A retry after ACK returns the original server sequence from the acknowledged receipt.

Receipt cleanup must respect both delivery and retention semantics and coordinate with media cleanup.

## Database acceptance invariants

Critical acceptance invariants are enforced at the SQLite boundary:

- inserting a mailbox row must advance `relationships.next_server_seq` exactly once;
- a media-backed mailbox row must consume the referenced `READY` upload and mark it `ATTACHED`;
- `PHOTO_VIDEO` must reference compatible media;
- other message types must not reference media;
- failures abort the insertion and roll back the transaction.

This prevents application-level success from diverging from database state if an expected state transition affects zero rows.

## Pull and ACK

Pull is non-destructive and authenticated. It uses a relationship-wide high-water cursor, so expired messages may create gaps.

ACK is the recipient's durability boundary. A client must persist messages locally before acknowledging them. For media messages, the referenced media must also be locally durable.

Receipt acknowledgement and mailbox deletion are committed in the same D1 batch. This means a lost ACK response cannot lose the idempotency record, while a failed ACK cannot leave the receipt marked acknowledged without the mailbox deletion completing. Repeated ACKs remain idempotent and concurrent ACKs are tested.

## Cursor and expiry semantics

Expired mailbox rows are skipped rather than returned as tombstones. Server sequence cursors are therefore high-water marks, not contiguous retained-row counts.

A client must tolerate gaps and advance using the highest returned server sequence only after local persistence.

## Media lifecycle

The current media lifecycle contract is documented separately in `docs/MEDIA_LIFECYCLE.md`.

The important invariant is that mailbox pull and ACK are not media deletion events. Media cleanup must follow the sender retry and recipient durability guarantees and be safe to retry after crashes.

## Migration/backfill note

Durable receipts were introduced after the initial mailbox schema. Existing pre-migration mailbox rows do not have receipts. The push path therefore retains a legacy mailbox conflict check while such rows remain.

Migration `0005_receipt_delivery_state.sql` backfills delivery and retention timestamps for existing receipts. Production deployment must either occur before real mailbox data exists or define an explicit backfill strategy for any older mailbox rows.

## Obsolete state

`mailbox_messages.acknowledged_at` remains in the schema for now, although the current ACK implementation deletes acknowledged rows immediately. It should be removed only after the protocol and migration history no longer require it.

## Audit principle

Cloud correctness is defined by the local durability contract, not by whether an HTTP request returned successfully. A request may commit before its response reaches the client, so every mutation must have an idempotent retry path or an explicit one-time/expiry rule.
