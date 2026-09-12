# Rucola Cloud Implementation Status

Date: 2026-09-12
Branch: `cloud/research`

## Phase 1 — `sync/pull`

**Status: complete and locally validated.**

The pull endpoint is implemented, hardened, and covered by the Worker test suite.

## Phase 2 — `sync/ack`

**Status: implementation complete; local validation pending.**

Implemented:

- `POST /v1/sync/ack` is now a real route.
- Device authentication is required.
- Only `ACTIVE` relationships can acknowledge.
- The relationship and highest known server sequence are read through a D1 `first-primary` session.
- `throughServerSeq` must be a positive safe integer.
- Acknowledgements beyond the server's known high-water mark return `ACK_CURSOR_AHEAD`.
- Acknowledgement is scoped to the authenticated relationship.
- Mailbox rows through the supplied high-water mark are deleted immediately after the durable ACK request.
- Repeating an acknowledgement is harmless and returns success with `deleted: 0` when nothing remains.
- Messages pushed after an earlier acknowledgement have a higher server sequence and are not removed by the earlier ACK.
- The legacy `/v1/sync/ack/...` route is no longer accepted.

### ACK protocol

Request:

```http
POST /v1/sync/ack
Authorization: Bearer <device-credential>
Content-Type: application/json

{"throughServerSeq":41}
```

Response:

```json
{
  "acknowledgedThrough": 41,
  "deleted": 41,
  "acknowledgedAt": 1770000000000
}
```

`throughServerSeq` is a relationship-wide contiguous high-water mark. The client must only send it after all messages through that sequence have been durably persisted locally.

### Cleanup semantics

The mailbox is a temporary delivery queue. ACK is the explicit durability boundary: once the recipient confirms a contiguous high-water mark, the corresponding server copies may be deleted.

The server deliberately does not attempt to infer acknowledgement from a pull request. If the client crashes after pull but before ACK, the messages remain available for another pull.

Repeated or lower ACKs are intentionally idempotent. The server does not maintain a second acknowledgement table because the relationship-wide sequence and the client's durable cursor already provide the required high-water-mark semantics.

## Important protocol choice

Pull returns all eligible mailbox messages for the authenticated relationship, including messages originally pushed by the same device. This keeps the cursor model relationship-wide and means local persistence must be idempotent by `messageId`.

The server cursor is a monotonic server sequence, not a timestamp. Pull remains non-destructive; ACK is the destructive operation.

## Hardening and consistency

Both pull and ACK use `withSession("first-primary")` when the latest relationship state matters. Cloudflare documents that `first-primary` starts the session from the latest primary database version and that subsequent queries in the session remain sequentially consistent. citeturn0search0turn0search2

The ACK implementation was deliberately kept relationship-scoped and rejects future cursors instead of silently clamping them. This makes client protocol bugs visible rather than silently deleting an unintended range.

## Validation

Phase 1 was previously validated with:

```text
4 test files passed
44 tests passed
0 failures
npm run typecheck passed
```

Phase 2 adds a dedicated ACK test suite covering:

- unauthenticated requests;
- exact route behavior;
- malformed and out-of-range cursors;
- future-sequence rejection;
- high-water-mark deletion;
- repeated ACK idempotency;
- relationship isolation;
- messages pushed after an earlier ACK;
- relationship-wide acknowledgement of sender-owned messages.

Run before considering Phase 2 complete:

```bash
npm test
npm run typecheck
```

## Next step

After the Phase 2 suite is green, perform a second hardening pass focused on **concurrent push/pull/ACK behavior and mailbox lifecycle invariants**. Then proceed to Phase 4 media/R2 work. The React Native cloud adapter should remain blocked until the sync protocol is stable.
