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

## C1 hardening decisions

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

## Current blockers before backend implementation

1. Decide maximum unacknowledged mailbox retention.
2. Decide whether manual code-only pairing is allowed. Recommendation: no; require the secure token.
3. Decide one-device-per-participant vs preparing for multiple devices immediately. Recommendation: one active device initially, but keep device identity distinct from participant identity.
4. Confirm that server receipt order is acceptable as the deterministic cross-participant total order.
5. Set photo/video size limits and multipart threshold.
6. Select the eventual E2E protocol/library separately after checking Expo/RN support.
7. Decide whether strict server-side sender-sequence contiguity is required when HTTP requests arrive out of order. Recommendation: do not require it initially; preserve sender sequence and make the client sync/order logic explicit.
8. Decide poison-message handling UX/state.
9. Decide behavior for already accepted mailbox messages when a relationship is ended.
10. Choose the concrete media schema shape: separate `media_uploads` table is recommended because it cleanly represents the pre-message upload lifecycle.

## Next implementation phase

**C2 — schema/protocol lock.** Convert the hard invariants into a concrete D1 schema and migration plan, including the relationship server-sequence counter, durable device/sender sequence strategy, idempotency constraints, media upload lifecycle, and ACK/retention state. No production Cloudflare resources should be created during C2.
