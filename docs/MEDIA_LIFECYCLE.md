# Cloud media lifecycle

## Goal

Rucola media is temporary synchronization data. Local device storage remains the durable source of truth. Cloud media exists only long enough to let the receiving device durably persist the message and its referenced media.

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
3. The client uploads the object to R2.
4. An authenticated completion operation verifies the object metadata and declared constraints, then transitions `PENDING -> READY`.
5. Only `READY` uploads can be accepted by message push.
6. Message acceptance atomically creates the mailbox message and transitions the upload `READY -> ATTACHED`.

Completion must be idempotent. Repeating completion for an already `READY` upload with the same validated object state should succeed; completion of `ATTACHED` must not revert it.

## Message acceptance

The database acceptance trigger is the final attachment boundary. It verifies relationship/device ownership, `READY` state and expiry before changing the upload to `ATTACHED`. If attachment fails, the mailbox insert and sequence allocation roll back with it.

A `PHOTO_VIDEO` message must reference an upload whose media type is `PHOTO` or `VIDEO`. Other message types cannot reference media. These type invariants are enforced at the D1 boundary as well as by request validation.

## Pull and ACK

Pulling a mailbox message never changes media state and never deletes the R2 object.

The receiver must durably persist both the encrypted message and its referenced media before ACKing through that server sequence. ACK deletes mailbox rows only; it does not itself delete media.

This separation is intentional: mailbox deletion is not proof that the receiver has durable media unless the receiver follows the protocol's durability boundary.

## Receipts and retries

A durable message receipt survives mailbox deletion and preserves the original `server_seq`, allowing a sender retry after a lost response to remain idempotent.

Receipt retention must cover the complete sender retry guarantee. Until that policy is finalized, receipt cleanup must not be implemented.

Because receipts currently reference `media_uploads` with `ON DELETE RESTRICT`, media metadata cannot be deleted while a retained receipt references it. Any future cleanup policy must account for this dependency.

## Cleanup

Cleanup must be retry-safe and must never make a still-retriable accepted message unrecoverable.

Safe cleanup candidates are:

- expired `PENDING` uploads that were never completed
- `ABANDONED` uploads after their retention window
- expired `READY` uploads that were never attached
- `ATTACHED` uploads only after the protocol's receipt/durability retention guarantees have expired

R2 deletion should be treated as eventually consistent cleanup. A failed delete must not corrupt D1 state; the cleanup operation must be safe to retry.

No cleanup job should delete an R2 object merely because a mailbox message was pulled or ACKed.

## Required implementation order

1. Define upload reservation/completion API and validation limits.
2. Add R2 binding and object-key generation.
3. Add upload lifecycle tests for retries, ownership, expiry and state transitions.
4. Implement R2-backed upload completion.
5. Add scheduled cleanup only after receipt retention is defined.
6. Remove obsolete lifecycle fields/routes only after client protocol semantics are finalized.
