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

Push acceptance creates the receipt and mailbox row in the same D1 batch. The receipt remains after mailbox ACK cleanup, so a lost push response can be retried without allocating another server sequence.

D1 batches are transactional: if a statement fails, the batch is rolled back. D1 processes statements in a batch sequentially and non-concurrently. citeturn2search1

### Pull authorization hardening

Mailbox pull now checks relationship state through a `first-primary` D1 session and joins the mailbox query against an ACTIVE relationship. This prevents a request from returning mailbox data after the relationship has become inactive. D1 sessions provide sequential consistency, and `first-primary` starts from the latest primary state. citeturn0search0turn2search1

### Privacy / retention decision

Receipts deliberately contain a digest rather than ciphertext. They are synchronization metadata, not cloud message history. Receipt retention/cleanup is still a follow-up hardening task and must be defined before production deployment.

### Migration note

`0002_message_receipts.sql` is being introduced before production deployment. Existing pre-migration mailbox rows do not have receipts; the push implementation retains a legacy mailbox conflict check so existing rows remain idempotent while they are still present. A production migration must either run before any real mailbox data exists or define an explicit backfill strategy.

## Remaining Phase 3 work

- test concurrent PUSH/PULL/ACK races against the new receipt invariant
- define and implement receipt retention/cleanup
- remove obsolete `acknowledged_at` once the protocol no longer needs it
- harden ACK semantics around relationship termination
- test expired mailbox rows and cursor gaps
- final full worker validation
