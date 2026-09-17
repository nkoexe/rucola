# Rucola Cloud Development Plan

> Current cloud implementation status and remaining integration work.
>
> Updated: 2026-09-17.

## 1. Purpose

This document describes the cloud backend used by Rucola without coupling the local-first React Native application to the network.

The cloud service is a **temporary synchronization mailbox**, not the authoritative store of user history. Local SQLite remains authoritative on each device. The backend moves opaque/encrypted messages and temporary media between paired devices while a participant is offline.

The implementation must preserve these properties:

- the app remains useful offline;
- existing local history survives backend outages;
- a message is not considered locally synchronized merely because the server accepted it;
- a recipient acknowledges only after durable local persistence;
- the server can delete a mailbox copy only after ACK;
- server code never needs plaintext message content;
- the UI does not call cloud endpoints directly.

## 2. Current implementation status

The cloud backend foundation is implemented and hardened on `main`. The earlier `cloud/research` and `fix/cloud-mailbox-direction` branches are historical workstreams whose relevant implementation and hardening changes have been incorporated into `main`.

Implemented:

- Cloudflare Worker routing and health checks;
- device credentials and authentication;
- pairing bootstrap, invitation creation and acceptance;
- invitation expiry and bounded confirmation attempts;
- relationship lifecycle enforcement;
- durable message push at `POST /v1/sync/push`;
- message-ID idempotency and sender-sequence validation;
- relationship-local server sequence allocation;
- durable message receipts and per-device delivery tracking;
- directional, non-destructive pull at `GET /v1/sync/pull`;
- directional ACK at `POST /v1/sync/ack`;
- expired mailbox/cursor-gap semantics;
- concurrent push/pull/ACK hardening;
- media reservation/upload/completion through R2;
- atomic `PHOTO_VIDEO` attachment during message acceptance;
- scheduled mailbox/receipt/media cleanup;
- bounded streamed media handling;
- database acceptance invariants and relationship isolation.

Not yet integrated end-to-end:

- the React Native cloud transport in the main mobile application;
- background synchronization;
- push notifications;
- final E2E encryption and key management;
- final production observability/metrics and deployment verification on the real Cloudflare resources.

## 3. Synchronization protocol

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
    | delete acknowledged partner-originated mailbox rows
    v
Temporary cloud state
```

### Critical rule

**Pull is not acknowledgement.**

Pull records delivery to the receiving device but does not delete the mailbox message. The recipient must validate/decrypt as appropriate, persist the message and any referenced media locally, commit that transaction, and only then send the ACK.

The ACK is a relationship-wide high-water mark, but it is directional: the receiving device can acknowledge only partner-originated messages that are live and recorded as delivered to that device. Expired mailbox rows may create gaps and do not block ACK advancement.

If the app crashes between local persistence and ACK, a later pull must remain safe and the local persistence operation must be idempotent.

## 4. Pull API

`GET /v1/sync/pull?after=<server_seq>&limit=<n>`

Parameters:

- `after`: last relationship-wide server sequence durably covered by the client;
- `limit`: default 50, maximum 100.

Behavior:

- returns only `server_seq > after`;
- returns partner-originated messages, never the requester's own outbound mailbox rows;
- orders by ascending `server_seq`;
- skips expired and acknowledged mailbox rows;
- records per-device delivery before returning messages;
- does not acknowledge or delete messages;
- may return a next cursor containing gaps because expired rows are skipped.

## 5. ACK API

`POST /v1/sync/ack`

```json
{
  "throughServerSeq": 41
}
```

The server verifies authentication, active relationship state, sequence bounds, delivery eligibility, and live undelivered partner messages before acknowledging and deleting the covered mailbox rows.

Repeated ACKs are idempotent. ACK never acknowledges or deletes the caller's own outbound mailbox rows.

## 6. Media

The media lifecycle is:

```text
PENDING → READY → ATTACHED
       ↘
        ABANDONED
```

Current endpoints:

- `POST /v1/media/create` — reserve an upload;
- `PUT /v1/media/{uploadId}` — stream the opaque media payload;
- `POST /v1/media/{uploadId}/complete` — validate the R2 object and transition it to `READY`;
- message push — atomically transitions `READY` to `ATTACHED` for `PHOTO_VIDEO`.

Initial transport limits are 20 MB for images and 100 MB for videos. `DRAWING` remains a compatible protocol type but new drawing pushes are rejected until drawing support exists end-to-end.

Media cleanup is bounded and restart-safe. Pull or ACK alone never authorizes R2 object deletion.

## 7. Durable receipts

`message_receipts` survives mailbox deletion so sender retries remain idempotent after lost HTTP responses.

A receipt contains immutable message identity/metadata, ciphertext digest, original `server_seq`, delivery expiry, per-device delivery state, acknowledgement state and finite retention state.

Current guarantees:

- unacknowledged mailbox delivery: 14 days;
- durable receipt retention: 30 days after acceptance;
- after an unacknowledged delivery expires, retry returns `MESSAGE_RETRY_EXPIRED` rather than creating a second acceptance;
- no indefinite retry/idempotency guarantee.

## 8. Database and migration notes

The Worker currently uses migration files under `cloud/worker/migrations/` through `0009_receipt_delivery_tracking.sql`.

Early development versions contained duplicate numeric migration prefixes. The files were renumbered into one ordered sequence. Before applying the current migration history to an already-populated remote D1 database, inspect its applied migration history and reconcile any old filenames before deploying.

The cloud Worker has an independent current schema from the mobile app's local SQLite schema; do not treat the two migration directories as interchangeable.

## 9. Development commands

From `cloud/worker`:

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

Deployment configuration is generated with `npm run render:deploy-config`; generated `.wrangler.deploy.jsonc` must remain ignored and must never be committed.

## 10. Phase plan

### Phase 0 — protocol lock and audit

**Complete.** Message envelope, cursor, ACK, receipt, retention and media boundaries are defined and covered by tests.

### Phase 1 — mailbox pull

**Complete.** Pull is directional, bounded, ordered, authenticated, non-destructive, and hardened for expiry gaps and per-device delivery tracking.

### Phase 2 — acknowledgement and cleanup

**Complete.** ACK is directional, durable, idempotent, cursor-bounded, and paired with mailbox deletion. Scheduled cleanup handles finite retention.

### Phase 3 — hardening

**Complete for the current backend foundation.** Coverage includes concurrency, relationship isolation, pairing races, cursor gaps, retry expiry, media streaming, and database invariants. Deeper production observability remains.

### Phase 4 — media/R2

**Complete for the current backend foundation.** Reservation, streaming upload, completion, attachment invariants, cleanup and lifecycle tests are implemented.

### Phase 5 — React Native cloud adapter

**Next.** Add a cloud transport/repository integration while preserving SQLite as the source of truth.

Required flow:

```text
reconcile outbox
    ↓
push ordered local messages
    ↓
pull partner messages
    ↓
validate/decrypt
    ↓
commit inbound transaction
    ↓
ACK durable high-water mark
```

### Phase 6 — background sync and notifications

Add retry/backoff, connectivity awareness, background execution and notifications after the foreground synchronization path works on two real devices.

### Phase 7 — end-to-end cryptography

Define device identity/key exchange and finalize the E2E protocol only after transport, storage and retry semantics are stable.

### Phase 8 — production readiness

Verify production D1/R2 resources, secrets, migration procedure, observability, abuse controls, recovery and real-device rollout behavior.

## 11. MVP definition

The cloud MVP is reached when two paired Android devices can authenticate, exchange opaque messages over the Internet, recover ordered history after the recipient is offline, persist it locally, acknowledge it, safely retry after failures, and preserve the server's plaintext-blind boundary.
