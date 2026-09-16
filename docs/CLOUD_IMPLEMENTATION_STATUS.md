# Rucola Cloud Implementation Status

Date: 2026-09-16
Branch: `cloud/research`

## Current state

The cloud workstream has moved well beyond the original pull/ACK prototype. The Worker now contains pairing, authenticated sync push/pull/ACK, durable message receipts, media reservation/upload/completion, cleanup/expiry handling, and database-enforced acceptance invariants. The Worker test suite covers the major synchronization, pairing, media, lifecycle and hardening cases.

The cloud branch remains separate from `main`. PR #15 (`fix/cloud-mailbox-direction`) is **open** and is the current hardening change required before the mailbox protocol should be treated as stable for two-device integration. It corrects an important ownership bug: a device must not pull or ACK its own mailbox copies as if they were partner deliveries.

## Implemented Worker surface

- `GET /health`
- `GET /health/schema`
- `GET /v1/auth/probe`
- `POST /v1/pairing/bootstrap`
- `POST /v1/pairing/create`
- `POST /v1/pairing/accept`
- `POST /v1/sync/push`
- `GET /v1/sync/pull`
- `POST /v1/sync/ack`
- media reservation/upload/completion routes under `/v1/media/*`

The media path is implemented at the Worker level and backed by R2 bindings/configuration, but production deployment/operational validation is still outstanding.

## Synchronization state

The current protocol uses:

- stable client-generated `message_id`;
- durable per-device `sender_seq`;
- relationship-scoped server `server_seq`;
- durable `message_receipts` for retry/idempotency semantics;
- non-destructive pull;
- destructive ACK after recipient durability;
- bounded mailbox retention and finite receipt retention.

The product decision is a **14-day mailbox delivery/retry window** for unacknowledged messages. The Worker retention constant has been restored to 14 days on the current `fix/cloud-mailbox-direction` hardening branch. This must remain aligned in future cloud changes, migrations, tests and cleanup logic.

## Phase history

### Pull

Complete and covered by the Worker suite.

### ACK

Implemented and covered by the Worker suite, including idempotency, cursor validation, relationship isolation and concurrent behavior. ACK is no longer relationship-wide in the sense of acknowledging sender-owned mailbox copies: the pending PR narrows acknowledgement to partner-originated deliveries for the authenticated device.

### Pairing

Bootstrap/create/accept and confirmation hardening are implemented. The user-facing five-emoji representation still needs to be connected to the mobile UI; the Worker does not make the technical token itself the user-facing pairing code.

### Media

Reservation, direct upload, completion and message attachment invariants are implemented. R2 is part of the intended production path. End-to-end mobile media synchronization remains unfinished because the mobile `SyncEngine` currently blocks media messages.

### Cleanup

Mailbox, receipt and media cleanup paths are implemented with bounded batches and restart-safe media cleanup state. Mailbox retention is 14 days; receipt retention remains a separate finite window.

## Mobile integration boundary

PR #14 is merged into `main`. It added the typed `CloudClient`, durable SQLite sync state/outbox/inbox, and `SyncEngine`.

The mobile sync engine currently:

- pushes due text/emoji outbox items;
- persists retry/backoff and blocked state;
- pulls inbound messages after a durable cursor;
- atomically persists inbound messages and advances the cursor;
- retries persisted ACKs;
- coalesces concurrent runs;
- preserves cursor/device state across replacement/recovery.

It intentionally does **not** yet:

- persist device credentials in SecureStore;
- integrate pairing into onboarding;
- schedule sync from app/background lifecycle;
- perform real E2E encryption;
- synchronize media end-to-end;
- configure a production cloud endpoint in the application.

## Validation

The Worker hardening history includes focused Vitest suites for pairing, push, pull, ACK, idempotency, lifecycle, media reservation/upload and cleanup. The latest repository commit history also contains extensive sync/data adversarial tests.

Do not use historical migration/native-test results as proof of the current tree without rerunning them.

## Next concrete work

1. Finish and validate PR #15.
2. Finish production deployment/operational hardening: rate limits, observability, migration/deployment safety, cleanup scheduling and recovery.
3. Wire the merged mobile cloud foundation into pairing, credentials and app lifecycle.
4. Integrate text/emoji online sync on two real Android devices.
5. Add the final E2E protocol/library.
6. Integrate media synchronization end-to-end.
