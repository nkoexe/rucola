# Rucola Cloud Implementation Status

Date: 2026-09-16
Branch: `fix/cloud-mailbox-direction`

## Current status

The cloud backend foundation is implemented and hardened through the temporary mailbox, ACK, media, cleanup, and concurrency boundaries. The React Native cloud adapter is the next integration step.

## Sync protocol

### `GET /v1/sync/pull`

**Status: complete and hardened.**

- Device authentication is required.
- Only `ACTIVE` relationships can synchronize.
- The caller's own outbound mailbox rows are excluded from its pull results.
- Partner-originated messages are returned in ascending `server_seq` order.
- `after` is a bounded relationship-local high-water cursor; `limit` defaults to 50 and is capped at 100.
- Pull is non-destructive. Repeating a pull safely returns still-unacknowledged messages.
- Delivery is recorded per receiving device before the response is returned.
- Expired mailbox rows are skipped, so cursor gaps are expected.
- Stored ciphertext is validated without requiring plaintext.

### `POST /v1/sync/ack`

**Status: complete and hardened.**

Request:

```http
POST /v1/sync/ack
Authorization: Bearer <device-credential>
Content-Type: application/json

{"throughServerSeq":41}
```

- Device authentication is required.
- Only `ACTIVE` relationships can acknowledge.
- `throughServerSeq` must be a positive safe integer and cannot exceed the server's known sequence.
- The ACK is directional: a device can acknowledge only partner-originated messages delivered to that device.
- Live undelivered partner messages prevent an ACK from crossing their sequence.
- Expired mailbox gaps do not block cursor advancement.
- Receipt acknowledgement and mailbox deletion are committed together in the D1 batch.
- Repeating an ACK is idempotent and returns success with `deleted: 0` when nothing remains.
- The legacy `/v1/sync/ack/...` route is not accepted.

The recipient must persist all covered data locally before sending the ACK. The server response is not the local durability boundary.

## Durable receipts

`message_receipts` preserves message identity, sender sequence, immutable message metadata, ciphertext hash, server sequence, delivery expiry, per-device delivery state, acknowledgement state, and finite retention data.

The receipt survives mailbox deletion so a sender can safely retry after a lost response. Unacknowledged delivery expires after 14 days; retained receipts remain for up to 30 days after acceptance.

## Pairing

**Status: complete and hardened.**

- bootstrap creates the first device and invitation;
- invitation acceptance creates the partner device;
- confirmation attempts are bounded and lockable;
- concurrent acceptance is tested so an invitation is consumed only once;
- relationship and device ownership are enforced by the database and Worker.

## Media / R2

**Status: implemented and hardened.**

- upload reservations use `POST /v1/media/create`;
- media upload uses `PUT /v1/media/{uploadId}`;
- completion uses `POST /v1/media/{uploadId}/complete`;
- ownership, MIME type, declared size, expiry, checksum, and lifecycle state are validated;
- upload bodies are bounded before they can exceed the reserved size in R2;
- `READY` media becomes `ATTACHED` atomically with `PHOTO_VIDEO` message acceptance;
- `DRAWING` remains in the protocol model but new drawing pushes are rejected until end-to-end drawing support exists;
- scheduled cleanup handles expired/orphaned media and retained receipt dependencies.

## Hardening

Implemented coverage includes:

- relationship isolation;
- directional pull and ACK semantics;
- concurrent push/pull/ACK races;
- sender-sequence conflict handling;
- message-ID idempotency and conflict detection;
- pairing acceptance races;
- cursor expiry gaps;
- durable receipt delivery tracking;
- exact ciphertext-view hashing;
- bounded streamed media uploads;
- relationship termination guards;
- retry-expiry handling.

## Validation

The cloud Worker test suite is the primary validation boundary. Before merge, run:

```bash
npm ci
npm run typecheck
npm test
```

The latest fully validated pre-docs-cleanup state was 15 test files and 111 tests passing. Documentation-only commits can still trigger a fresh CI run and should be rechecked before merge.

## Next step

Connect the React Native sync engine to the stable protocol while preserving SQLite as the local source of truth. The mobile flow should remain:

```text
push local outbox → pull partner messages → persist transactionally → ACK durable cursor
```

Do not make the UI depend directly on the cloud endpoints.
