# Cloud Sync Hardening

This document records security, correctness and operational hardening for the cloud synchronization backend. Current protocol behavior belongs in `docs/CLOUD_ARCHITECTURE.md`; this file tracks hardening status and remaining work.

## Current status

### Complete

- cryptographic pairing token generation and hashed invitation material
- bounded confirmation-code attempts and lockout
- device-bound authentication
- durable message receipts
- per-device receipt delivery/ACK state
- database-enforced message acceptance sequence invariant
- database-enforced media attachment invariant
- database-enforced media/message type compatibility
- concurrent ACK hardening
- relationship termination guards for pull and ACK
- expiry/cursor-gap coverage
- sender-device binding for legacy mailbox retry classification
- bounded streamed media uploads
- scheduled mailbox/receipt/media cleanup
- exact ciphertext-view hashing regression coverage

### Locked decisions

#### Finite retry guarantee

The production cloud deliberately has finite retention:

- unacknowledged mailbox messages: **14-day delivery/retry window**;
- durable message receipts: **30-day retention after acceptance**;
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

`cloud/research` contains the cloud backend work, with `fix/cloud-mailbox-direction` carrying the current hardening changes. Operational hardening includes abuse/rate limiting, migration safety, secret handling, cleanup/recovery and bounded resource usage.

## Remaining implementation / hardening

- deeper production observability and structured metrics;
- explicit migration/backfill procedure for any already-populated remote database before deploying the renumbered migration history;
- final decision on removal of legacy `mailbox_messages.acknowledged_at` after protocol history is confirmed;
- production resource/secrets verification;
- end-to-end React Native integration and real two-device validation;
- final E2E encryption/key-management implementation.

## Durable message receipts

The mailbox is intentionally temporary, but message identity must survive mailbox deletion long enough to make sender retries safe. `message_receipts` stores synchronization metadata plus a SHA-256 digest of opaque ciphertext.

It preserves relationship/message identity, sender device/sequence, immutable message metadata, ciphertext digest, the original server sequence and acceptance timestamp, plus:

- `delivery_expires_at` — the end of the 14-day mailbox delivery guarantee;
- `delivered_to_device_id` / `delivered_at` — the receiving-device delivery record used to validate ACK eligibility;
- `acknowledged_at` — set when the recipient crosses the durability boundary;
- `retention_expires_at` — the end of the 30-day post-acceptance receipt retention period.

Push acceptance creates the receipt and mailbox row in the same D1 transaction. A retry while delivery is still possible returns the original server sequence. A retry after an unacknowledged delivery window has expired returns `MESSAGE_RETRY_EXPIRED` rather than creating a second acceptance. A retry after ACK returns the original server sequence from the retained receipt.

Receipt cleanup respects both delivery and retention semantics and coordinates with media cleanup.

## Database acceptance invariants

Critical acceptance invariants are enforced at the SQLite/D1 boundary:

- inserting a mailbox row must advance `relationships.next_server_seq` exactly once;
- a media-backed mailbox row must consume the referenced `READY` upload and mark it `ATTACHED`;
- `PHOTO_VIDEO` must reference compatible media;
- other message types must not reference media;
- failures abort the insertion and roll back the transaction.

This prevents application-level success from diverging from database state if an expected state transition affects zero rows.

## Pull and ACK

Pull is non-destructive and authenticated. It uses a relationship-wide high-water cursor and filters the caller's own outbound mailbox rows, so expired messages may create gaps.

ACK is the recipient's durability boundary. A client must persist messages locally before acknowledging them. For media messages, the referenced media must also be locally durable.

Receipt acknowledgement and mailbox deletion are committed in the same D1 batch. The ACK path is directional: a device may acknowledge only partner-originated messages that were recorded as delivered to that device. Repeated ACKs remain idempotent and concurrent ACKs are tested.

## Cursor and expiry semantics

Expired mailbox rows are skipped rather than returned as tombstones. Server sequence cursors are therefore high-water marks, not contiguous retained-row counts.

A client must tolerate gaps and advance using the highest returned server sequence only after local persistence. Expired gaps do not block ACK advancement when all live partner messages through the requested cursor have been delivered.

## Media lifecycle

The current media lifecycle contract is documented separately in `docs/MEDIA_LIFECYCLE.md`.

The important invariant is that mailbox pull and ACK are not media deletion events. Media cleanup follows the sender retry and recipient durability guarantees and is safe to retry after crashes.

## Migration/backfill note

Durable receipts were introduced after the initial mailbox schema. Existing pre-receipt mailbox rows do not have receipts, so the push path retains a legacy mailbox conflict check while such rows remain.

The receipt delivery-state migration is now `cloud/worker/migrations/0006_receipt_delivery_state.sql`; production deployment must verify the existing remote migration history before applying this branch because earlier development versions used duplicate migration prefixes that were subsequently renumbered.

## Obsolete state

`mailbox_messages.acknowledged_at` remains in the schema for now, although the current ACK implementation deletes acknowledged partner-originated rows immediately. It should be removed only after the protocol and migration history no longer require it.

## Audit principle

Cloud correctness is defined by the local durability contract, not by whether an HTTP request returned successfully. A request may commit before its response reaches the client, so every mutation must have an idempotent retry path or an explicit one-time/expiry rule.
