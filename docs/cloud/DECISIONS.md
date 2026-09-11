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
- Pairing uses a high-entropy one-time invitation token; the cute human code is only a confirmation/discovery aid.
- Future E2E payloads should be opaque to the Worker and R2.

## Current blockers before backend implementation

1. Decide maximum unacknowledged mailbox retention.
2. Decide whether manual code-only pairing is allowed. Recommendation: no; require the secure token.
3. Decide one-device-per-participant vs preparing for multiple devices immediately. Recommendation: one active device initially, but keep device identity distinct from participant identity.
4. Confirm that server receipt order is acceptable as the deterministic cross-participant total order.
5. Set photo/video size limits.
6. Select the eventual E2E protocol/library separately after checking Expo/RN support.
