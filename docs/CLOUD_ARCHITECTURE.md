# Rucola Cloud Architecture

## Purpose

The cloud backend is a temporary synchronization service for exactly one two-person relationship. It is **not** a cloud message archive and must never become the application's permanent source of truth.

The mobile device owns durable history in local SQLite. The cloud temporarily holds encrypted/opaque message payloads and temporary media until the receiving device has durably persisted them locally.

## Components

```text
React Native app
      │
      ├── local SQLite + app-owned media
      │
      └── sync engine
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

### Worker

The Worker authenticates devices and implements pairing and synchronization HTTP APIs. It orchestrates D1 state transitions but must not become a second application data store.

### D1

D1 stores synchronization metadata:

- relationships and lifecycle state;
- device credentials and participant roles;
- pairing invitations;
- temporary mailbox messages;
- durable message receipts;
- media upload metadata and lifecycle state.

D1 must never require plaintext message content.

### R2

R2 stores temporary encrypted/opaque media objects associated with `media_uploads`. R2 object existence is not sufficient to make an upload attachable; D1 metadata controls lifecycle state.

## Relationship model

A relationship has exactly two participants:

- `ME` — the device that created/bootstraped the relationship;
- `PARTNER` — the device that accepted the invitation.

Relationship states are:

- `PAIRING` — invitation/bootstrap phase;
- `ACTIVE` — normal synchronization;
- `ENDED` — synchronization is stopped.

Authentication is device-bound. Revoked devices cannot continue normal synchronization.

## Pairing

Bootstrap creates the relationship and the first device. The creator can create an invitation with:

- a cryptographically random token;
- a six-digit human confirmation code;
- an expiry;
- bounded confirmation attempts and lockout.

The human-facing code is not a standalone credential. Token and code material are stored hashed server-side. Successful acceptance consumes the invitation and creates the partner device.

## Message model

Supported synchronized message types are:

- `TEXT`
- `EMOJI`
- `PHOTO_VIDEO`
- `DRAWING`

Messages have two independent sequence concepts:

- `sender_seq` — monotonically assigned by a sending device;
- `server_seq` — monotonically assigned within the relationship when the server accepts a message.

`message_id` is the stable client identity of a message.

The server treats message identity and immutable payload metadata as idempotent. Retrying an accepted message with the same identity and identical payload returns the original `server_seq`. Reusing the identity with different content is a conflict.

## Durable acceptance

A successful push must atomically establish all state required to retry safely.

For a normal message this means:

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

The D1 acceptance invariants additionally require the mailbox insertion to advance the relationship sequence exactly once.

For `PHOTO_VIDEO`, acceptance additionally requires a valid `READY` media upload belonging to the authenticated sender and relationship. The upload transitions to `ATTACHED` atomically with message acceptance.

If any acceptance invariant fails, the D1 transaction must roll back rather than leaving a partially accepted message.

## Mailbox semantics

Mailbox rows are temporary synchronization copies.

The server must:

- preserve every accepted message until its retention boundary;
- preserve ordering by `server_seq`;
- never collapse a sequence of messages to only the newest message;
- never delete a message merely because it was pulled;
- allow the recipient to retry pull without losing data.

The mailbox currently has a seven-day message expiry. Expired messages are skipped rather than returned as tombstones.

## Pull protocol

Pull uses a relationship-wide high-water cursor:

```text
GET /v1/sync/pull?cursor=<server_seq>&limit=<n>
```

The cursor means "return messages with `server_seq` greater than this value". It is not a count of retained mailbox rows and therefore may contain gaps when messages expire.

Pull is non-destructive.

A client must persist returned messages idempotently using `message_id` before advancing its durable local synchronization state.

## ACK protocol

ACK is the destructive durability boundary:

```text
POST /v1/sync/ack
{
  "throughServerSeq": <n>
}
```

The receiving client may ACK only after every message through that sequence has been durably persisted locally.

For media messages this means the referenced media must also be durably persisted locally before the ACK covers that message.

The Worker validates that the cursor is not ahead of the relationship's known sequence and then deletes eligible mailbox rows. Repeated ACKs are idempotent. ACK does not delete media objects directly.

## Durable receipts

Mailbox deletion cannot be the only source of message identity because a sender may retry after receiving no HTTP response even though acceptance committed.

`message_receipts` therefore survives mailbox deletion and stores only synchronization metadata plus a SHA-256 digest of the opaque ciphertext. It preserves the original `server_seq` and immutable message identity.

A matching retry returns the original server sequence instead of allocating another one. A mismatching retry is rejected.

Receipt retention is intentionally **not yet finalized**. Cleanup must not be implemented until the maximum sender retry guarantee has been defined.

## Media

Media has an independent lifecycle:

```text
PENDING → READY → ATTACHED
       ↘
        ABANDONED
```

See `docs/MEDIA_LIFECYCLE.md` for the detailed contract.

The important boundaries are:

1. R2 object existence;
2. D1 upload readiness;
3. atomic attachment to an accepted message;
4. recipient local durability;
5. eventual cleanup.

Pulling or ACKing a mailbox row is never, by itself, permission to delete the R2 object.

## Privacy boundary

The Worker is designed to operate on opaque encrypted message/media payloads. Server-side synchronization logic may inspect metadata required for routing, authorization, sequencing and lifecycle enforcement, but it must not require plaintext application content.

## Failure model

The protocol assumes requests can fail after the server has committed and before the client receives the response.

Therefore every important operation must be safe to retry:

- pairing operations are one-time/expiry constrained;
- message push is idempotent by message identity and immutable payload;
- media completion must be idempotent;
- pull is non-destructive;
- ACK is idempotent;
- cleanup is eventually consistent and retry-safe.

The system should prefer a recoverable duplicate request over irreversible data loss.

## Current API surface

Implemented Worker routes:

- `GET /health`
- `GET /health/schema`
- `GET /v1/auth/probe`
- `POST /v1/pairing/bootstrap`
- `POST /v1/pairing/create`
- `POST /v1/pairing/accept`
- `POST /v1/sync/push`
- `GET /v1/sync/pull`
- `POST /v1/sync/ack`

Media upload endpoints and R2 integration are intentionally not implemented yet.

## Implementation rules

When extending the cloud backend:

- keep local SQLite authoritative;
- keep the mailbox temporary;
- make durability boundaries explicit;
- prefer database-enforced invariants for critical state transitions;
- make retries safe;
- do not store plaintext application content;
- do not add permanent cloud history without an explicit product decision;
- do not let R2 cleanup race ahead of the message/receipt durability contract.
