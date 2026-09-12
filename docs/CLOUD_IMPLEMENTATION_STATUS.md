# Rucola Cloud Implementation Status

Date: 2026-09-12
Branch: `cloud/research`

## Phase 1 — `sync/pull`

**Status: implementation complete; hardening changes applied; local validation confirmed by the developer.**

Implemented:

- `GET /v1/sync/pull` is now a real route instead of `501`.
- Device authentication is required.
- Revoked device credentials are rejected.
- Relationship ownership is derived from the authenticated device.
- Only `ACTIVE` relationships can pull.
- Relationship lookup failures return `503` instead of an unhandled database error.
- `after` is a non-negative safe-integer server-sequence cursor.
- `limit` defaults to 50 and is bounded to 1–100.
- Queries use `server_seq > after`.
- Results are ordered ascending by `server_seq`.
- `LIMIT limit + 1` is used to determine `hasMore` without a second count query.
- Acknowledged rows are excluded.
- Expired rows are excluded.
- Repeated pulls remain non-destructive because pull does not mutate acknowledgement state.
- D1 `first-primary` sessions are used so the read starts from the latest database version and remains sequentially consistent within the query session.
- Stored ciphertext is normalized back to the existing UTF-8 wire representation used by push.
- Invalid stored mailbox data is distinguished from a database availability failure.
- Tests cover authentication, revoked credentials, empty mailboxes, ordering, pagination, retries, cursor stability, very-high cursors, acknowledged/expired filtering, relationship isolation, invalid cursor/limit values, and inactive relationships.

## Important protocol choice

The pull endpoint currently returns all eligible mailbox messages for the authenticated relationship, including messages originally pushed by the same device.

This keeps the server cursor a simple relationship-wide high-water mark. The client must make local message persistence idempotent using the stable `messageId`; a message already present locally becomes a no-op. This is preferable to creating a second cursor model for each sender and keeps the eventual ACK high-water mark contiguous.

The server does **not** consider a pulled message acknowledged. The client must durably persist its local state before sending the future ACK request.

## API

Request:

```http
GET /v1/sync/pull?after=0&limit=50
Authorization: Bearer <device-credential>
```

Response:

```json
{
  "messages": [
    {
      "messageId": "...",
      "senderDeviceId": "...",
      "senderParticipant": "ME",
      "senderSeq": 1,
      "createdAt": 1770000000000,
      "serverSeq": 1,
      "receivedAt": 1770000000001,
      "type": "TEXT",
      "ciphertext": "...",
      "encryptionVersion": 1,
      "mediaUploadId": null
    }
  ],
  "nextCursor": 1,
  "hasMore": false
}
```

## Hardening review

The pull implementation was audited for:

- credential revocation;
- relationship isolation;
- cursor parsing and safe-integer boundaries;
- limit boundaries;
- repeated/unacknowledged pulls;
- expired and acknowledged rows;
- cursors beyond the current server sequence;
- stable cursor behavior when no eligible row remains;
- pagination ordering;
- database failure classification;
- malformed stored ciphertext classification;
- route/protocol consistency with the planned ACK high-water-mark design.

No protocol change was required. The pull cursor remains a relationship-local server-sequence high-water mark, and pull remains strictly non-destructive.

## Validation

The developer ran the full Worker test suite and typecheck after the Phase 1 implementation:

```text
4 test files passed
44 tests passed
0 failures
```

```text
npm run typecheck
passed
```

After the hardening changes in this status update, rerun the same two commands before starting ACK implementation.

## Commits

Phase 1 implementation is split into focused commits on `cloud/research`:

- mailbox pull implementation
- pull route wiring
- pull protocol tests
- implementation status document
- pull error-handling hardening
- pull edge-case hardening tests

## Next step

Run:

```bash
npm test
npm run typecheck
```

After those pass, begin **Phase 2: `POST /v1/sync/ack` + mailbox cleanup**. The ACK implementation should use the documented contiguous `throughServerSeq` high-water mark and must be tested for monotonic/idempotent behavior, future-sequence rejection, relationship isolation, and safe cleanup.
