# Rucola Cloud Implementation Status

Date: 2026-09-12
Branch: `cloud/research`

## Phase 1 — `sync/pull`

**Status: implementation complete; runtime validation still pending.**

Implemented:

- `GET /v1/sync/pull` is now a real route instead of `501`.
- Device authentication is required.
- Relationship ownership is derived from the authenticated device.
- Only `ACTIVE` relationships can pull.
- `after` is a non-negative safe-integer server-sequence cursor.
- `limit` defaults to 50 and is bounded to 1–100.
- Queries use `server_seq > after`.
- Results are ordered ascending by `server_seq`.
- `LIMIT limit + 1` is used to determine `hasMore` without a second count query.
- Acknowledged rows are excluded.
- Expired rows are excluded.
- Repeated pulls remain non-destructive because pull does not mutate acknowledgement state.
- D1 `first-primary` sessions are used so the read starts from the latest database version and remains sequentially consistent within the query session. citeturn0search2turn0search3
- Stored ciphertext is normalized back to the existing UTF-8 wire representation used by push.
- Tests cover authentication, empty mailbox, ordering, pagination, retries, acknowledged/expired filtering, relationship isolation, invalid cursor/limit values, and inactive relationships.

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

## Review notes

The implementation deliberately avoids timestamp-based pagination. D1 prepared statements are used with bound parameters, which is the recommended query pattern and avoids interpolating request values into SQL. citeturn0search0

The existing mailbox index on `(relationship_id, server_seq)` matches the pull query's relationship/cursor/order pattern, so no schema change was required for Phase 1.

Cloudflare D1 documents `LIMIT` and prepared parameter binding through the standard Worker binding API, and D1's current row-size limit is far above the existing Rucola ciphertext limit. citeturn0search0turn0search4

## Validation limitation

The implementation was committed directly to GitHub because this environment does not have network access to clone the repository and execute its local Wrangler/Vitest toolchain. Therefore, this phase is **code-reviewed but not locally test-executed in this session**.

Before treating Phase 1 as fully validated, run from `cloud/worker`:

```bash
npm test
npm run typecheck
```

If either command fails, fix the failure before beginning ACK implementation.

## Commits

Phase 1 implementation is split into focused commits on `cloud/research`:

- mailbox pull implementation
- pull route wiring
- pull protocol tests
- this implementation status document

## Next step

Run the Worker test suite and typecheck. After those pass, perform a dedicated pull hardening review, then implement **Phase 2: `POST /v1/sync/ack` + mailbox cleanup**.
