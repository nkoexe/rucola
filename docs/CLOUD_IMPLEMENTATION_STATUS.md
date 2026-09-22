# Rucola Cloud Implementation Status

Date: 2026-09-22  
Branch: `feature/pairing-emoji-share-link`

## Current status

The cloud backend foundation is implemented and hardened through the temporary mailbox, ACK, media, cleanup, pairing, concurrency, and database-invariant boundaries. The React Native side now has secure identity/key storage, pairing lifecycle state, the transport-neutral pairing boundary, and a real application-owned `CloudRuntime` that constructs the encrypted `SyncEngine` from persisted identity state.

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

**Status: prototype handshake and transport migration complete; production validation pending.**

- bootstrap creates the first device and short-lived invitation;
- five-emoji codes are the only human-facing pairing credential;
- emoji entry and HTTPS share-link inputs converge on the same pairing session;
- `pairing_sessions` relays CPace draft-20 shares and opaque handoff/confirmation envelopes without receiving the relationship key;
- responder device ID and credential hash are bound to the session;
- duplicate confirmation publication is idempotent for the same responder identity;
- responder pairing state is stored securely before relay publication and can be resumed after restart;
- completion inserts the exact responder device and atomically consumes the invitation / activates the relationship;
- the Worker serves a no-store five-emoji HTTPS landing page and an optional `assetlinks.json` response when a real Android signing fingerprint is configured;
- the old serialized package path remains only as an internal compatibility API.

## Media / R2

**Status: implemented and hardened.**

- upload reservations use `POST /v1/media/create`;
- media upload uses `PUT /v1/media/{uploadId}`;
- completion uses `POST /v1/media/{uploadId}/complete`;
- ownership, MIME type, declared size, expiry, checksum, and lifecycle state are validated;
- upload bodies are bounded before they can exceed the reserved size in R2;
- `READY` media becomes `ATTACHED` atomically with `PHOTO_VIDEO` message acceptance;
- `DRAWING` remains in the protocol model but new drawing pushes are rejected until end-to-end drawing support exists;
- scheduled cleanup handles expired/orphaned media, retained receipt dependencies, and stale unpaired relationships whose invitations have expired.

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

The cloud Worker test suite remains the backend validation boundary. CI status is intentionally tracked by GitHub Actions rather than frozen in this document.

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
- The mobile pairing protocol persists recoverable `PAIRING` state separately from `ACTIVE` state and can resume a pending invitation after restart.
- The user-facing pairing credential is exactly five emojis; the invitation token, cloud credential, relationship key, and any serialized pairing package remain technical pairing material and must not be exposed in the UI.
- The target migration replaces the current visible pairing-package handoff with two transport options: emoji-only entry and an HTTPS five-emoji share link.
- The transport-neutral pairing boundary is now implemented in `pairingTransport.ts`; direct emoji input and share-link input normalize to the same canonical five-emoji code.
- `PairingManager` and `CloudRuntime` now expose a human-facing invitation projection containing only the pairing code, share URL, and expiry. The legacy package-bearing path remains isolated as temporary compatibility code until the hidden handshake is implemented.
- Auth probing now exposes the relationship lifecycle state so the initiating device can transition from `PAIRING` to `ACTIVE` after the partner joins.
- `CloudRuntime` now owns `CloudClient`, `CloudIdentityStore`, `PairingManager`, the SQLite sync-state store, `AesGcmSyncCodec`, and one coalescing `SyncEngine` instance for the active identity.
- `SyncEngine` now passes the durable sender sequence into the codec, so the sequence is covered by AES-GCM authenticated context exactly as designed.
- The app triggers synchronization on startup, after pairing, after local message creation, and when returning to the foreground.
- Settings exposes an explicit `sync now` retry control for physical prototype testing and recovery.
- SQLite schema v6 persists the encrypted outbound envelope in `sync_outbox` before the first network push, so AES-GCM ciphertext is reused across ambiguous retries instead of being regenerated with a fresh nonce.
- The sync test suite now exercises a simulated two-device encrypted TEXT burst in both directions and a lost-response/idempotent retry.
- The Worker cleanup suite now covers expiry of an unpaired pairing relationship without touching active relationships.

The prototype implementation now completes the transport-neutral pairing flow end-to-end in code: five-emoji entry and HTTPS share links feed the hidden pairing session, the responder can recover after restart, the Worker completes the relationship atomically, and the app exposes no package/token/credential/key material. The legacy package API remains only for compatibility. Production approval and physical two-device validation are still separate gates.

## Remaining work

1. Validate the encrypted TEXT/EMOJI online loop on two Android devices against the dev Worker, including restart/retry behavior.
2. Validate both emoji entry and HTTPS share-link/App Link pairing on two real Android devices.
3. Configure and verify `RUCOLA_ANDROID_APP_LINK_FINGERPRINTS` with the actual signing certificate used by the installed APK.
4. Complete the production CPace/dependency/runtime review; the repository implementation is intentionally pinned to draft-20 while the active CFRG draft is newer.
5. Finish end-to-end PHOTO_VIDEO synchronization.
6. Add background synchronization/notifications only after the foreground path is proven.
7. Complete production migration/recovery, resource/secrets verification, and observability.
8. Decide whether to remove the legacy `mailbox_messages.acknowledged_at` field after the current protocol is fully migrated.

## Next step

The code gate is complete for the prototype. Next is two-device Android validation plus the production cryptographic/runtime review and real App Link association.

Do not make the UI depend directly on cloud endpoints.
