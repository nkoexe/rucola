# Cloud media lifecycle

## Goal

Rucola media is temporary synchronization data. Local device storage remains the durable source of truth. Cloud media exists only long enough to let the receiving device durably persist the message and its referenced media.

The cloud is production synchronization infrastructure, not permanent media storage.

## Media types and limits

Initial synchronized media types are `PHOTO` and `VIDEO`. `DRAWING` remains represented by the protocol model but is not part of the initial usable product until the drawing editor exists.

Server-side size limits:

- images: **20 MB maximum**;
- videos: **100 MB maximum**.

These are transport/storage limits. Rounded corners, cropping, 4:3 or 1:1 framing and other presentation behavior belong to the client UI.

## States

D1 metadata and the R2 object have independent lifecycle state:

| D1 state | Expected R2 state | Meaning |
| --- | --- | --- |
| `PENDING` | object may be absent/incomplete | Upload has been reserved but is not attachable to a message. |
| `READY` | object exists and passed completion validation | Upload may be referenced by exactly one accepted `PHOTO_VIDEO` message. |
| `ATTACHED` | object must remain available | An accepted message references the upload. |
| `ABANDONED` | object should eventually be deleted | Upload can no longer become message data. |

The D1 row is authoritative for whether an upload is attachable. R2 presence alone never makes an object attachable.

## Upload flow

1. Authenticated device creates a short-lived `PENDING` upload reservation.
2. The reservation binds the upload to the relationship, creating device, media type, size and object key.
3. The client uploads the opaque/encrypted object to R2.
4. An authenticated completion operation verifies the object metadata and declared constraints, then transitions `PENDING -> READY`.
5. Only `READY` uploads can be accepted by message push.
6. Message acceptance atomically creates the mailbox message and transitions the upload `READY -> ATTACHED`.

Completion must be idempotent. Repeating completion for an already `READY` upload with the same validated object state should succeed; completion of `ATTACHED` must not revert it.

The server rejects media over the configured type-specific size limit before making an upload attachable.

## Message acceptance

The database acceptance trigger is the final attachment boundary. It verifies relationship/device ownership, `READY` state and expiry before changing the upload to `ATTACHED`. If attachment fails, the mailbox insert and sequence allocation roll back with it.

A `PHOTO_VIDEO` message must reference an upload whose media type is `PHOTO` or `VIDEO`. Other message types cannot reference media. These type invariants are enforced at the D1 boundary as well as by request validation.

## Pull and ACK

Pulling a mailbox message never changes media state and never deletes the R2 object.

The receiver must durably persist both the encrypted message and its referenced media before ACKing through that server sequence. ACK deletes mailbox rows only; it does not itself delete media.

This separation is intentional: mailbox deletion is not proof that the receiver has durable media unless the receiver follows the protocol's durability boundary.

## Receipts and retries

A durable message receipt survives mailbox deletion and preserves the original `server_seq`, allowing a sender retry after a lost response to remain idempotent.

The production retry contract is finite:

- unacknowledged mailbox messages have a **14-day delivery/retry window**;
- durable message receipts are retained for **30 days after acceptance**;
- there is no indefinite retry or idempotency guarantee.

Media cleanup must account for both windows. A still-retriable accepted message must not lose the state needed to fulfill its documented guarantee.

Because receipts currently reference `media_uploads` with `ON DELETE RESTRICT`, media metadata cannot be deleted while a retained receipt references it. Any cleanup implementation must account for this dependency.

## Cleanup

Cleanup will be performed by scheduled Cloudflare Worker work once the R2 integration exists.

Safe cleanup candidates include:

- expired `PENDING` uploads that were never completed;
- `ABANDONED` uploads after their retention window;
- expired `READY` uploads that were never attached;
- `ATTACHED` uploads only after the message retry/receipt retention contract allows removal.

Cleanup must be:

- retry-safe and idempotent;
- bounded per invocation;
- driven by D1 lifecycle/expiry state;
- ordered so database references and retry guarantees are not broken;
- observable enough to detect stuck uploads or deletion failures.

R2 deletion is eventually consistent cleanup. A failed delete must not corrupt D1 state; a later invocation must be able to retry safely.

No cleanup job may delete an R2 object merely because a mailbox message was pulled or ACKed.

## Privacy

Media objects are expected to be opaque encrypted payloads from the application perspective. The server may inspect transport metadata required to enforce size, lifecycle, authorization and routing rules, but it must not require plaintext media content.

The final end-to-end encryption protocol is intentionally deferred until the transport and storage lifecycle are stable.

## Required implementation order

1. Define upload reservation/completion API and validation limits.
2. Add R2 binding and object-key generation.
3. Add upload lifecycle tests for retries, ownership, expiry, size/type limits and state transitions.
4. Implement R2-backed upload completion.
5. Integrate attachment with durable message acceptance.
6. Implement scheduled cleanup only after the retention contract is covered by tests.
7. Add operational metrics/logging and failure recovery.
8. Connect the React Native sync engine.
9. Add the final E2E encryption layer after the transport/storage contract is stable.
