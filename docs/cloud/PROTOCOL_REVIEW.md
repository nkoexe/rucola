# Rucola Cloud Protocol Hardening Review

**Status:** C1 protocol review completed; the major protocol findings have been implemented and regression-tested on the `cloud/research` workstream.

**Branch:** `cloud/research`

**Purpose:** This document is the historical adversarial review that shaped the Worker protocol. Current deployment/protocol notes live in `cloud/worker/README.md`; current mobile architecture lives in `docs/ARCHITECTURE.md`.

## 1. Review conclusion

The original architecture survives the adversarial pass: Cloudflare Workers + D1 + R2 remains the backend direction, and SQLite on the phone remains the permanent source of truth.

The key protocol risks identified during C1 were subsequently turned into implementation constraints and tests:

- media uploads need an explicit temporary lifecycle before message attachment;
- server sequence allocation must be transactionally safe;
- sender sequences must be durable on the client;
- duplicate pushes must be idempotent while sequence/message conflicts are rejected;
- media must be valid before a message becomes deliverable;
- ACK must be idempotent and independent of read state;
- mailbox expiry is a real delivery boundary;
- malformed inbound messages must not permanently block later valid messages;
- device authentication must remain separate from eventual E2E encryption identity.

No finding required changing the backend stack.

## 2. Current decisions

### Message identity and ordering

- `message_id` is client-generated and stable across retries.
- `(relationship_id, message_id)` is unique.
- Sender sequence is durable per device on the client.
- Server sequence is allocated per relationship for accepted mailbox messages.
- Server sequence is mailbox acceptance order, not a replacement for the sender's local creation/order metadata.
- Reusing a sender sequence with a different message identity is a protocol conflict.
- Accepted message contents are immutable; only lifecycle metadata changes.

### ACK

ACK means that the recipient has durably persisted the complete message and any required local media state.

It does **not** mean displayed, opened, read, or notified.

ACK is directional and idempotent. The current Worker prevents a device from acknowledging its own outbound mailbox rows or partner messages that were not delivered to that device.

### Local durability

The recipient follows:

```text
pull
 ↓
validate/decrypt/process
 ↓
SQLite transaction
 ├─ persist accepted messages
 ├─ update active/history state
 └─ advance durable pull cursor
 ↓
COMMIT
 ↓
ACK
```

The mobile `SyncEngine` enforces the important client boundary: cursor advancement and ACK happen after the durable local commit path.

### Pairing

The user-facing mechanism is exactly five emojis. That code is a usability/confirmation mechanism, not the security credential.

The actual pairing protocol uses a higher-entropy invitation/token plus bounded confirmation attempts, expiry, and one-time consumption. The mobile app must keep those technical credentials invisible to the user.

### Device lifecycle

The MVP targets one active device per participant. `device_id` remains separate from participant identity, and authentication credentials are separate from future encryption identity.

Automatic server-based history recovery is deliberately not part of the design; the mailbox is temporary rather than an archive.

## 3. Retention contract

The retention question left open in the original C1 review is now resolved:

| Resource | Retention / boundary |
| --- | --- |
| Local outbound unsynchronized message/outbox | 30 days, then terminal local deletion |
| Cloud mailbox message | 14 days |
| Durable delivery receipt | 30 days |
| Pending media reservation | short-lived, currently 24 hours |
| Ready temporary media | finite-lived, currently 14 days |

The mailbox may therefore lose delivery capability after 14 days of non-delivery. This is intentional and must be visible in product/recovery behavior rather than treated as an infinite guarantee.

Durable receipts outlive mailbox rows so retries remain idempotent after acceptance/ACK. Attached media is protected while its durable receipt exists and can be cleaned after that lifecycle ends, while orphaned media remains reclaimable.

## 4. Media lifecycle

The implemented Worker treats media as an independent temporary resource:

```text
create upload reservation
        ↓
PENDING
        ↓
bounded R2 upload
        ↓
completion
        ↓
READY/usable
        ↓
message acceptance references the upload
        ↓
mailbox lifecycle + receipt lifecycle
        ↓
cleanup
```

The Worker enforces photo/video size and MIME constraints and uses fixed-length streaming so the upload path is bounded.

The mobile client has typed create/upload/complete APIs, but full end-to-end media synchronization from the mobile `SyncEngine` remains unfinished.

## 5. Pull / cursor-gap semantics

Pull is bounded and ordered by `serverSeq`.

Expired mailbox rows can create gaps in the server-sequence space. The current protocol intentionally allows clients to advance across expired gaps while still refusing to acknowledge live undelivered partner messages.

This means `nextCursor` represents the durable server-sequence boundary the client has locally committed, including sequences that are known to be unavailable because they expired or were explicitly discarded under the client protocol.

## 6. Corrupt / undecryptable messages

The original review called for a poison-message strategy. The current mobile implementation resolves this at the client boundary:

- expected undecryptable messages are explicitly classified as discardable;
- their server sequence is recorded as dropped during the same atomic cursor commit;
- later valid messages can continue through the bounded batch;
- unexpected codec/runtime exceptions are not swallowed and prevent cursor/ACK advancement.

The current implementation therefore does not treat all exceptions as permanent message corruption. The future E2E codec must preserve the explicit expected-error contract.

No server-side dead-letter queue is currently required for MVP.

## 7. Concurrency and idempotency

The Worker regression suite covers the important races from C1:

- concurrent message acceptance and server sequence allocation;
- duplicate/idempotent pushes;
- ACK retries and concurrent acceptance/ACK behavior;
- pairing acceptance races;
- media/message lifecycle ordering;
- two-device mailbox behavior.

Database constraints remain the final authority for uniqueness. Application-level preflight checks are not treated as sufficient protection against concurrent requests.

## 8. E2E boundary

The Worker stores ciphertext plus the minimum envelope metadata required for routing, validation, ordering, and lifecycle management.

The final E2E protocol/library is not selected yet. Do not implement custom cryptography as part of transport hardening. Authentication credentials and encryption identity remain separate concerns.

## 9. Current implementation state

The cloud workstream is substantially beyond the original C1 proposal:

- pairing bootstrap/create/accept exists;
- authenticated push/pull/ACK exists;
- directional mailbox ownership is enforced;
- durable receipts exist;
- media reservation/upload/completion and cleanup exist;
- finite retention is encoded in Worker behavior;
- concurrency/idempotency and cursor-gap behavior are covered by regression tests.

The remaining gap is integration into the complete mobile product lifecycle: credential persistence, pairing UI flow, application/background sync ownership, and end-to-end media synchronization still need to be completed before the first real online product milestone.

## 10. Maintenance rule

This document is a historical review, not the live implementation specification.

When the protocol changes:

1. update `cloud/worker/README.md` for current Worker behavior;
2. update `docs/ARCHITECTURE.md` for cross-layer invariants;
3. update tests first or alongside the protocol change;
4. keep this document focused on the findings and decisions that motivated the design.
