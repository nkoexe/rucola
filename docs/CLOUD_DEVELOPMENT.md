# Rucola Cloud Development Plan

> Status snapshot and implementation plan for the `cloud/research` branch.
>
> Research date: 2026-09-12.

## 1. Purpose

This document is the working plan for completing Rucola's cloud backend without coupling the local-first React Native application to the network.

The cloud service is a **temporary synchronization mailbox**, not the authoritative store of user history. Local SQLite remains authoritative on each device. The backend exists to move encrypted messages and temporary media between devices while a participant is offline.

The implementation must preserve these product-level properties:

- the app remains useful offline;
- existing local history survives backend outages;
- a message is not considered synchronized merely because the server accepted it;
- a recipient acknowledges a message only after durable local persistence;
- the server may delete a mailbox item only after acknowledgement;
- server code never needs plaintext message content;
- the UI talks to domain/repository code rather than directly to HTTP endpoints.

## 2. Current branch status

The branch already contains a real Cloudflare Worker/D1 backend foundation.

### Implemented

- Cloudflare Worker entrypoint and routing.
- D1 schema and initial migration.
- Device credentials and authentication probing.
- Pairing bootstrap.
- Invitation creation and acceptance.
- Invitation expiry and single-use semantics.
- Confirmation-code attempt limiting/lockout.
- Pairing bootstrap rate limiting.
- Relationship lifecycle: `PAIRING`, `ACTIVE`, `ENDED`.
- Message push endpoint.
- Message payload validation and size limits.
- Message-ID idempotency/conflict detection.
- Sender-sequence conflict detection.
- Relationship-local server sequence allocation.
- Temporary mailbox retention timestamps.
- Media-upload metadata model and attachment validation in message push.
- D1 primary-session verification after a write, anticipating read replication.
- Message pull endpoint with bounded pagination and relationship-local server cursor.
- Pull authentication, isolation, expiry/ack filtering, and hardening tests.
- Worker, pairing-hardening, sync-push, and sync-pull test suites.

### Explicitly incomplete

- `POST /v1/sync/ack`.
- Mailbox cleanup after acknowledgement.
- Complete media upload/download lifecycle.
- R2 binding and production bucket configuration.
- Client-side cloud transport in the React Native branch.
- Background synchronization.
- Push notification integration.
- End-to-end cryptographic implementation/key management.
- Production Cloudflare database/bucket configuration.

The acknowledgement route remains intentionally inactive until the contiguous high-water-mark protocol is implemented. Pull is now active and no longer a `501` placeholder.

## 3. Existing backend model

The D1 migration currently defines:

- `relationships`
- `devices`
- `invitations`
- `media_uploads`
- `mailbox_messages`

Important mailbox invariants already represented in SQL include:

- unique `(relationship_id, message_id)`;
- unique `(relationship_id, sender_device_id, sender_seq)`;
- unique `(relationship_id, server_seq)`;
- one mailbox message per media upload;
- relationship status checks;
- positive sequence numbers;
- mailbox expiry timestamps;
- acknowledgement timestamps.

The existing push path validates the relationship, authenticates the device, validates the message, detects replay/conflict cases, allocates a server sequence, writes the message, and verifies the committed state before returning success.

## 4. Target synchronization protocol

The core protocol is:

```text
Sender device
    |
    | POST /v1/sync/push
    v
Cloud mailbox (D1)
    |
    | GET /v1/sync/pull?after=<cursor>
    v
Recipient device
    |
    | persist message transactionally in local SQLite
    |
    | POST /v1/sync/ack
    v
Cloud mailbox
    |
    | remove acknowledged temporary copy
    v
D1 cleanup
```

### Critical rule

**Pull is not acknowledgement.**

A successful pull means only that the server returned a mailbox item. The item remains available until the recipient explicitly acknowledges it.

The recipient must:

1. receive a batch;
2. validate/decrypt it as appropriate;
3. persist it to local SQLite in the correct local order;
4. commit that local transaction;
5. only then send the acknowledgement.

If the app crashes between steps 3 and 5, the message must be returned again on a later pull. The local persistence operation must therefore be idempotent.

## 5. Pull API design

### Implemented endpoint

`GET /v1/sync/pull`

Authentication is the same device credential mechanism already used by push.

### Query parameters

Use a relationship-local server sequence cursor rather than timestamps.

- `after`: last server sequence durably acknowledged by the client;
- `limit`: bounded batch size, default 50, maximum 100.

The server requests messages with:

```text
server_seq > after
ORDER BY server_seq ASC
LIMIT limit + 1
```

The extra row is used only to determine `hasMore`.

### Response shape

```json
{
  "messages": [
    {
      "messageId": "...",
      "senderParticipant": "ME",
      "senderSeq": 12,
      "serverSeq": 41,
      "type": "TEXT",
      "ciphertext": "...",
      "encryptionVersion": 1,
      "createdAt": 1770000000000,
      "mediaUploadId": null
    }
  ],
  "nextCursor": 41,
  "hasMore": false
}
```

The implementation additionally returns `senderDeviceId` and `receivedAt` because those fields are useful to the sync domain and already exist in the mailbox model.

### Pull invariants

- Only the authenticated device's relationship is queried.
- Revoked device credentials are rejected.
- Only an `ACTIVE` relationship may synchronize.
- Messages are returned in ascending `server_seq` order.
- The server never returns messages from another relationship.
- The server never exposes another device's credential.
- A cursor does not delete or acknowledge anything.
- A client can safely repeat a pull request.
- Batch size is bounded.
- Expired mailbox entries are not returned.
- Acknowledged mailbox entries are not returned.
- Pulling an item does not modify its acknowledgement state.
- Database failures are distinguished from invalid stored mailbox data.

### Cursor semantics

The client should treat `serverSeq` as an opaque monotonic position, not as a timestamp.

Do not advance the durable local cursor until the corresponding messages have been persisted locally.

A practical MVP rule is to acknowledge the highest contiguous server sequence that is durably persisted. If a future implementation supports holes or partial acknowledgement, it must not acknowledge a later sequence while leaving an earlier required message unpersisted.

## 6. Acknowledgement API design

### Proposed endpoint

`POST /v1/sync/ack`

The acknowledgement body should contain a bounded list of server sequence numbers or, preferably for the MVP, a single contiguous high-water mark:

```json
{
  "throughServerSeq": 41
}
```

The high-water-mark form is preferred because it maps directly to ordered pull semantics and makes the client's durable cursor easy to reason about.

### Acknowledgement invariants

- The device must be authenticated.
- The relationship must be active.
- The supplied sequence must be a positive safe integer.
- The server must only affect rows belonging to the authenticated relationship.
- Acknowledgement must be monotonic.
- Repeating the same acknowledgement must be harmless.
- Acknowledging a sequence greater than the server's known sequence must be rejected.
- The server should mark/delete only messages that are actually eligible for acknowledgement.
- Acknowledgement must not alter message contents.

## 7. Mailbox cleanup strategy

The MVP should keep cleanup tied to acknowledgement rather than relying on a periodic task for correctness.

Recommended sequence:

1. authenticate device;
2. validate the high-water mark;
3. transactionally mark eligible mailbox rows acknowledged;
4. remove acknowledged rows after the acknowledgement has been durably recorded, or use a single transaction if the chosen D1 schema makes that safe;
5. retain enough information to make repeated acknowledgement idempotent.

The important invariant is that a message must never disappear before the recipient has had a chance to durably persist it.

A later cleanup mechanism may remove abandoned/expired rows, but expiry is a recovery mechanism, not the normal delivery acknowledgement path.

## 8. Phase plan

### Phase 0 — protocol lock and audit

- freeze message envelope semantics;
- confirm cursor model;
- confirm acknowledgement semantics;
- document failure cases;
- verify D1 indexes.

**Status: complete.**

### Phase 1 — mailbox pull

- implement `GET /v1/sync/pull`;
- authenticate device;
- enforce relationship isolation;
- add pagination/cursor validation;
- add non-destructive retry semantics;
- add adversarial tests.

**Status: complete.** Pull was implemented, locally validated at 44/44 tests plus typecheck, then hardened with additional edge-case coverage. The same test/typecheck commands should be rerun after the latest hardening commits.

### Phase 2 — acknowledgement and cleanup

Implement `POST /v1/sync/ack` with a contiguous `throughServerSeq` high-water mark.

Required tests:

- unauthenticated ACK;
- revoked device;
- inactive relationship;
- malformed body;
- zero/negative/non-integer/unsafe sequence;
- future sequence rejection;
- first acknowledgement;
- duplicate acknowledgement;
- lower/replayed acknowledgement;
- relationship isolation;
- cleanup correctness;
- concurrent push and ACK;
- pull before/after ACK;
- crash-safe semantics at the protocol boundary.

### Phase 3 — hardening

- review rate limits;
- review credential handling;
- review payload limits;
- review database failure behavior;
- review expiry and cleanup races;
- add structured observability without logging ciphertext.

### Phase 4 — R2 media

- bind R2;
- create upload-intent endpoint;
- validate ownership and size/type;
- direct upload to R2;
- attach media atomically to a message;
- define orphan cleanup;
- implement download authorization.

### Phase 5 — React Native cloud adapter

- add cloud repository/transport abstraction;
- keep SQLite as source of truth;
- implement pull → local transaction → ACK;
- persist server cursor locally;
- make message application idempotent;
- never block normal offline usage on cloud failure.

### Phase 6 — background sync and notifications

- background pull scheduling;
- retry/backoff;
- connectivity awareness;
- push notification integration if product requirements justify it.

### Phase 7 — end-to-end cryptography

- define device identity/key model;
- define pairing key exchange;
- encrypt message envelopes before upload;
- authenticate ciphertext/envelopes;
- rotate/revoke keys safely;
- ensure server remains plaintext-blind.

### Phase 8 — production readiness

- production D1 and R2 resources;
- secrets/configuration;
- deployment workflow;
- observability and alerting;
- abuse/rate-limit review;
- backup/recovery strategy;
- migration procedure;
- client rollout/version compatibility.

## 9. Parallel work

Cloud backend work can proceed in parallel with the React Native migration as long as the protocol remains stable.

Good parallel tasks:

- backend ACK implementation;
- backend hardening/tests;
- RN local sync repository interfaces;
- RN SQLite cursor persistence;
- message envelope/domain types;
- media abstraction interfaces;
- background-sync orchestration design.

Avoid implementing the mobile network adapter against an unstable ACK protocol. The mobile side should consume the frozen domain contract after Phase 2.

## 10. MVP definition

The cloud MVP is complete when:

- two paired devices can authenticate;
- either device can push an opaque message envelope;
- the other device can pull it with a cursor;
- pulling does not acknowledge it;
- the recipient can durably persist it locally and acknowledge it;
- acknowledged messages are removed from the temporary mailbox;
- retries are safe;
- duplicate pushes are idempotent;
- relationship isolation is enforced;
- expired mail is eventually discarded;
- the server never requires plaintext message content.

Media, background sync, notifications, and production cryptographic key management can follow after this core path is stable.
