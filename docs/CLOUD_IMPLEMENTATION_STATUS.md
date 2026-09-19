# Rucola Cloud Implementation Status

Date: 2026-09-19  
Branch: `main`

## Current status

The cloud backend foundation is implemented and hardened through the temporary mailbox, ACK, media, cleanup, pairing, concurrency, and database-invariant boundaries. The React Native cloud adapter is now partially wired for dev health checks; the complete mobile pairing/crypto/sync lifecycle remains the next integration step.

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

**Status: complete and hardened at the backend layer.**

- bootstrap creates the first device and invitation;
- invitation acceptance creates the partner device;
- confirmation attempts are bounded and lockable;
- concurrent acceptance is tested so an invitation is consumed only once;
- relationship and device ownership are enforced by the database and Worker;
- the user-facing confirmation code remains separate from the higher-entropy invitation token and device credentials.

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
- retry-expiry handling;
- database-level acceptance invariants, including receipt delivery-state constraints.

## Validation

The cloud Worker test suite is the primary validation boundary. Run:

```bash
npm ci
npm run typecheck
npm test
```

The latest completed backend validation before the current CI workflow fix was 15 test files and 111 tests passing. A fresh CI run is required to validate the current workflow and remote Cloudflare resources end-to-end.

## Current mobile security and pairing foundation

Implemented on the current development branch:

- `expo-secure-store` is now a direct mobile dependency with a reproducible npm lock entry.
- `CloudIdentityStore` provides a typed secure-storage boundary for relationship ID, device ID, participant, cloud credential, and relationship encryption key.
- Relationship encryption keys are generated as 256-bit AES keys using Expo Crypto.
- The prototype E2E codec uses AES-256-GCM with fresh 12-byte nonces, 16-byte authentication tags, a versioned envelope, and authenticated additional data.
- TEXT and EMOJI are supported by the prototype codec; media remains deliberately blocked until the full media sync path is implemented.
- Unit tests cover round-trip encryption, nonce uniqueness, tampering, wrong keys, malformed envelopes, encoding, and secure-identity validation.
- The native integration harness includes a SecureStore/AES-GCM smoke test using a dedicated test storage key so it cannot overwrite a real paired identity.
- Pairing now binds the installation-generated relationship key to the Worker invitation through a SHA-256 commitment; the raw relationship key never crosses the Worker API.
- The mobile pairing protocol persists recoverable `PAIRING` state separately from `ACTIVE` state and can recreate a pending pairing package after restart.
- The human confirmation is exactly five emojis; the high-entropy invitation token and encryption key remain technical pairing material.
- Auth probing now exposes the relationship lifecycle state so the initiating device can transition from `PAIRING` to `ACTIVE` after the partner joins.

The implementation is committed, but CI validation of the current head is still pending.

## Remaining work

1. Complete the actual Android pairing UX for the protocol, including secure local QR/camera or equivalent out-of-band relationship-key transfer.
2. Add the application-owned CloudRuntime and connect the existing `SyncEngine` to the real codec and identity state.
3. Update the SyncEngine codec contract to pass sender sequence into authenticated encryption.
4. Wire local TEXT/EMOJI writes into the durable outbox and trigger startup/foreground/after-send synchronization.
5. Add two-device integration coverage and validate the signed dev APK on real Android devices.
6. Finish end-to-end PHOTO_VIDEO synchronization.
7. Add background synchronization/notifications.
8. Complete production migration/recovery, resource/secrets verification, and observability.
9. Decide whether to remove the legacy `mailbox_messages.acknowledged_at` field after the current protocol is fully migrated.

## Next step

Run the current CI validation to catch Expo/native API or lockfile issues. Once green, continue with pairing protocol/lifecycle integration.

Do not make the UI depend directly on cloud endpoints.
