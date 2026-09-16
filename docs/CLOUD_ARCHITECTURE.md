# Rucola Cloud Architecture

## Purpose

The cloud backend is the synchronization service for exactly one two-person relationship. It is **not** a cloud message archive and must never become the application's permanent source of truth.

The mobile device owns durable history in local SQLite. The cloud temporarily holds opaque message payloads and temporary media until the receiving device has durably persisted them locally.

The transport/storage protocol is deliberately independent of the eventual end-to-end encryption design. E2E encryption will be added after synchronization and media boundaries are stable.

## Components

```text
React Native app
      │
      ├── local SQLite + app-owned media
      │
      ├── CloudClient
      │
      └── SyncEngine
              │
              ▼
      Cloudflare Worker
        │          │
        ▼          ▼
       D1          R2
   relationship   temporary
   + mailbox      media
   + receipts
```

The Worker authenticates devices and implements pairing, synchronization and media HTTP APIs. D1 holds authorization/lifecycle metadata; R2 holds temporary media bytes.

## Relationship and pairing

A relationship has exactly two participants:

- `ME` — the bootstrap/creator device;
- `PARTNER` — the device accepting the invitation.

Relationship states are `PAIRING`, `ACTIVE`, and `ENDED`.

Authentication is device-bound. Revoked devices cannot continue normal synchronization.

The **user-facing pairing mechanism is five emojis**. The backend uses a separate high-entropy invitation token plus a bounded confirmation mechanism. The token is an implementation credential and must not be exposed as the human-facing code.

The mobile `CloudClient` exposes bootstrap/create/accept transport, but onboarding has not yet integrated it.

## Message model

Supported synchronized message types are:

- `TEXT`
- `EMOJI`
- `PHOTO_VIDEO`
- `DRAWING`

`message_id` is stable and client-generated. `sender_seq` is durable per sending device. `server_seq` is allocated per relationship on acceptance.

The server enforces immutable payload identity for retries. A matching retry returns the original acceptance; conflicting reuse is rejected.

## Durable acceptance

For normal messages:

```text
validate
  ↓
allocate server sequence
  ↓
insert mailbox row
  ↓
create durable receipt
  ↓
commit
```

For `PHOTO_VIDEO`, a valid `READY` media upload belonging to the authenticated sender and relationship must also be attached atomically with message acceptance.

Database constraints/invariants are part of the acceptance boundary. A failed acceptance must not leave a partially accepted message.

## Mailbox semantics

Mailbox rows are temporary synchronization copies. The server must preserve every accepted message until its finite delivery boundary and must never collapse a burst to only the newest message.

**Current implementation:** mailbox retention is 7 days (`MAILBOX_RETENTION_MS` in the Worker). Older documentation described 14 days; that is no longer an accurate description of the current code and must not be treated as a final product decision until explicitly reconciled.

Expired mailbox rows are skipped rather than returned as tombstones. Pull cursors are high-water marks and can contain gaps.

## Pull and directional delivery

Pull is authenticated and non-destructive. The intended two-device behavior is directional: a device pulls messages originating from its partner, not its own sent messages.

PR #15 (`fix/cloud-mailbox-direction`) is currently open against `cloud/research` to enforce that behavior and to ensure ACK only acknowledges/deletes partner-originated mailbox rows. Until it is merged and validated, the cloud branch should not be treated as having the final two-device mailbox semantics.

## ACK

ACK is the destructive durability boundary:

```text
POST /v1/sync/ack
{"throughServerSeq": <n>}
```

The recipient may ACK only after every covered partner message has been durably persisted locally, including required media.

ACK is idempotent and must be safe to retry after a lost response. Durable receipt state survives mailbox deletion for the finite retry/idempotency window.

The directional hardening changes the ACK interpretation from the older relationship-wide behavior to partner-originated deliveries for the authenticated recipient.

## Durable receipts

`message_receipts` survives mailbox deletion and stores synchronization metadata plus a ciphertext digest. It preserves message identity, sender sequence/device, original server sequence and lifecycle timestamps.

The current protocol also tracks delivery-to-device metadata for directional acknowledgement. This is part of the PR #15 hardening and is not considered final until that PR is merged.

The intended receipt retention remains finite; the exact production contract must match the code and product decision before deployment.

## Media

Media has an independent lifecycle:

```text
PENDING → READY → ATTACHED
       ↘
        ABANDONED
```

Current Worker media endpoints support reservation, direct upload and completion. R2 stores the object while D1 controls lifecycle/authorization.

Initial server-side limits currently implemented are 20 MB for images and 100 MB for videos. These are transport/storage limits, not presentation constraints.

Pulling or ACKing a mailbox row is never, by itself, permission to delete the R2 object.

## Privacy boundary

The Worker is designed to operate on opaque encrypted payloads. Server-side logic may inspect metadata needed for routing, authorization, sequencing and lifecycle enforcement, but must not require plaintext application content.

The current mobile sync codec is an abstraction and does not implement final E2E cryptography yet.

## Failure model

Important operations must be safe to retry within their documented finite retention windows:

- pairing is expiry/one-time constrained;
- message push is idempotent by stable message identity and immutable payload;
- media completion is idempotent;
- pull is non-destructive;
- ACK is idempotent;
- cleanup is bounded and retry-safe.

## Current Worker API surface

Implemented routes on `cloud/research` include:

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

## Production boundary

The Worker implementation is substantially complete as a protocol foundation, but it is not yet the final production service. Remaining work includes final directional validation, retention-policy reconciliation, operational rate limiting/observability, migration/deployment safety, cleanup scheduling/recovery, and integration with the mobile pairing/sync lifecycle.

The mobile online prototype is **not complete** until two real devices can pair and exchange messages through this backend.
