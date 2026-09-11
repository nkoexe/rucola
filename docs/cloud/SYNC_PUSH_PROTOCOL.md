# Mailbox Push Protocol

Status: **FROZEN for MVP implementation**

Endpoint:

```http
POST /v1/sync/push
Authorization: Bearer <device credential>
Content-Type: application/json
```

The cloud is a temporary mailbox. It is not the canonical message history and does not implement active-message/archive semantics.

## Request

```json
{
  "messageId": "01J...",
  "senderSeq": 42,
  "type": "TEXT",
  "ciphertext": "...",
  "encryptionVersion": 1,
  "createdAt": 1760000000000,
  "mediaUploadId": "..."
}
```

### Fields

- `messageId`: client-generated stable message identity. It must remain unchanged across retries.
- `senderSeq`: positive safe integer owned by the originating device. It is unique within that device's relationship namespace and may contain gaps.
- `type`: one of `TEXT`, `EMOJI`, `PHOTO_VIDEO`, `DRAWING`.
- `ciphertext`: opaque encrypted payload. The Worker does not decrypt or interpret it.
- `encryptionVersion`: positive integer identifying the payload encryption protocol/version.
- `createdAt`: client creation timestamp in Unix milliseconds. Metadata only; it does not determine mailbox order.
- `mediaUploadId`: optional media upload reference. Required for `PHOTO_VIDEO`; forbidden for message types without media in the MVP.

The request does **not** contain `relationshipId` or `participant`. Both are derived from the authenticated device credential.

## Ownership

### Client-owned

- `messageId`
- `senderSeq`
- `type`
- `ciphertext`
- `encryptionVersion`
- `createdAt`
- `mediaUploadId` (when applicable)

### Server-owned

- `relationshipId`
- `senderDeviceId`
- `senderParticipant`
- `serverSeq`
- `serverReceivedAt`
- `expiresAt`

The server must never trust client-supplied relationship or participant identity.

## Authentication and authorization

1. Authenticate the bearer credential against the hashed device credential.
2. Reject missing, invalid, or revoked credentials with `401`.
3. Derive relationship and participant from the authenticated device record.
4. The device must belong to an `ACTIVE` relationship.
5. A revoked device cannot push, even if its credential is otherwise valid.

## Validation

The implementation must reject malformed or unsafe input before attempting mailbox mutation.

- Request body is bounded by the existing API JSON body limit.
- Body must be a JSON object, not `null` or an array.
- `messageId` must use the protocol's strict message-ID format and bounded length.
- `senderSeq` must be an integer, `>= 1`, and within JavaScript's safe-integer range.
- `type` must exactly match the four supported message types.
- `ciphertext` must be non-empty and bounded by the explicit MVP ciphertext limit.
- `encryptionVersion` must be an integer `>= 1` and bounded to the supported numeric range.
- `createdAt` must be a safe integer Unix-millisecond timestamp and must satisfy the implementation's reasonable timestamp bounds.
- `mediaUploadId`, when present, must satisfy the same strict identifier format/length rules.
- Unknown fields are ignored unless the implementation deliberately chooses strict schema rejection; protocol correctness must not depend on them.

The exact byte/character limits belong to the implementation constants and tests, not to client-controlled database limits.

## Ordering

There are three distinct ordering concepts:

1. `senderSeq`: relative creation order for messages from one originating device.
2. `serverSeq`: mailbox acceptance order within one relationship.
3. local `orderIndex`: presentation/history insertion order on a phone.

`serverSeq` is allocated from `relationships.next_server_seq` transactionally. Never use `MAX(server_seq) + 1`.

Sender sequence gaps and out-of-order arrival are valid. For example, sender sequence `12` may arrive before `10` or `11`.

`serverSeq` does not claim to represent true conversational creation order when devices were offline or messages were concurrent.

## Idempotency

### Exact retry

A repeated push with the same `(relationshipId, messageId)` and the exact same immutable payload is an idempotent success.

It returns the original acceptance result. It must not:

- create another mailbox row;
- allocate another `serverSeq`;
- advance `next_server_seq`;
- modify the existing message;
- extend or otherwise alter its server-owned retention state.

### Message-ID conflict

If `(relationshipId, messageId)` already exists but any immutable client-owned field conflicts, reject with:

```text
409 MESSAGE_ID_CONFLICT
```

Do not overwrite the existing mailbox message.

### Sender-sequence conflict

If `(relationshipId, senderDeviceId, senderSeq)` is already used by a different `messageId`, reject with:

```text
409 SENDER_SEQUENCE_CONFLICT
```

This is a protocol violation, not a new message.

## Server sequence allocation

For a genuinely new message:

1. Verify authentication and relationship state.
2. Validate the complete request.
3. Verify media ownership/state when a media reference is supplied.
4. Begin one D1 transaction/batch for mailbox mutation.
5. Re-check idempotency/conflict state as required by the transaction design.
6. Read the current `relationships.next_server_seq`.
7. Insert the mailbox row using that value as `serverSeq`.
8. Increment `relationships.next_server_seq` by one in the same transaction.
9. Commit both operations atomically.

Concurrent distinct pushes may receive server sequences in whichever order D1 serializes their successful transactions. That order is the authoritative mailbox acceptance order.

A failed transaction must not consume a server sequence.

An idempotent retry must not consume a server sequence.

## Media

Media is uploaded independently before message attachment:

```text
create upload -> R2 upload -> READY -> push message -> ATTACHED
```

For `PHOTO_VIDEO`:

- `mediaUploadId` is required.
- The referenced upload must belong to the authenticated device's relationship.
- The upload must be `READY` and unexpired.
- The Worker must verify the upload state before accepting the message.
- Attachment and mailbox insertion must be consistent; a failed message transaction must not leave the upload incorrectly marked `ATTACHED`.

For `TEXT`, `EMOJI`, and `DRAWING`, `mediaUploadId` is absent in the MVP.

The Worker does not proxy media bytes.

## Response

Successful first push:

```json
{
  "messageId": "01J...",
  "senderSeq": 42,
  "serverSeq": 17,
  "acceptedAt": 1760000000000
}
```

The same logical response is returned for an exact idempotent retry.

`acceptedAt` is the server acceptance timestamp (`serverReceivedAt` in storage), not the client `createdAt`.

## HTTP error contract

| Status | Error code | Meaning |
|---:|---|---|
| `400` | `INVALID_REQUEST` | Malformed JSON, invalid field, unsupported type, invalid sequence/timestamp, or otherwise invalid request |
| `401` | `UNAUTHENTICATED` | Missing, invalid, or revoked device credential |
| `409` | `RELATIONSHIP_INACTIVE` | Authenticated device belongs to a relationship that is not `ACTIVE` |
| `409` | `MESSAGE_ID_CONFLICT` | Existing message ID has conflicting immutable payload |
| `409` | `SENDER_SEQUENCE_CONFLICT` | Sender sequence is already assigned to another message |
| `409` | `MEDIA_CONFLICT` | Media reference is not attachable to this message/device/relationship |
| `413` | `PAYLOAD_TOO_LARGE` | Ciphertext/request exceeds the explicit protocol limit |
| `500` | `DATABASE_UNAVAILABLE` | Required database operation failed |

The implementation may use more specific internal validation codes, but the externally observable semantics above must remain stable.

## Immutability

Once accepted, mailbox message content and identity are immutable.

There is no server-side edit, replacement, archive, or active-message operation.

The cloud mailbox only stores enough state to deliver the accepted encrypted message and track temporary delivery/retention state.

## Transaction invariants

After every successful new push:

- exactly one mailbox row exists for the message;
- exactly one server sequence was assigned;
- `next_server_seq` advanced exactly once;
- the assigned `serverSeq` is unique within the relationship;
- the sender sequence is unique within the sender-device namespace;
- any attached media belongs to the same relationship and is consumed by at most one mailbox message.

After an idempotent retry:

- database state is unchanged;
- the original `serverSeq` is returned;
- no counter is incremented.

After any failed transaction:

- no partial mailbox row remains;
- no server sequence is consumed;
- no media state is incorrectly advanced by the failed transaction.

## Explicit non-goals

Mailbox push does not:

- synchronize permanent local history;
- determine local `orderIndex`;
- archive/activate messages;
- decrypt ciphertext;
- establish E2E identity;
- provide realtime delivery;
- guarantee that `serverSeq` matches conversational creation order;
- block delivery because sender sequences have gaps.

## Required adversarial tests

Before push is frozen as implemented, tests must cover at minimum:

1. first successful push;
2. exact retry;
3. concurrent exact retries;
4. conflicting message ID;
5. conflicting sender sequence;
6. sender sequence gaps;
7. out-of-order sender sequence arrival;
8. concurrent distinct messages;
9. revoked device;
10. inactive relationship;
11. malformed/unknown fields and invalid values;
12. oversized ciphertext;
13. media ownership failure;
14. media not-ready/expired failure;
15. successful media attachment;
16. failed transaction rollback;
17. failed insert does not consume `serverSeq`;
18. idempotent retry does not consume `serverSeq`.
