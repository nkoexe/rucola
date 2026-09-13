# Cloud media lifecycle

## Goal

Rucola media is temporary synchronization data. Local device storage remains the durable source of truth. Cloud media exists only long enough to let the receiving device durably persist the message and its referenced media.

The cloud is production synchronization infrastructure, not permanent media storage.

## Media types and limits

Initial synchronized media types are `PHOTO` and `VIDEO`. `DRAWING` remains represented by the protocol model but is not part of the initial usable product until the drawing editor exists.

Server-side size limits:

- images: **20 MiB maximum**;
- videos: **100 MiB maximum**.

These are transport/storage limits. Rounded corners, cropping, 4:3 or 1:1 framing and other presentation behavior belong to the client UI.

The current reservation API accepts these MIME types:

- `PHOTO`: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`;
- `VIDEO`: `video/mp4`, `video/quicktime`, `video/webm`.

The optional checksum is a SHA-256 hexadecimal digest of the opaque uploaded object bytes. When supplied, the Worker passes it to R2 and completion verifies the stored checksum before the upload can become `READY`.

## States

D1 metadata and the R2 object have independent lifecycle state:

| D1 state | Expected R2 state | Meaning | Expiry |
| --- | --- | --- | --- |
| `PENDING` | object may be absent/incomplete | Upload has been reserved but is not attachable to a message. | 24h |
| `READY` | object exists and passed completion validation | Upload may be referenced by exactly one accepted `PHOTO_VIDEO` message. | 14d |
| `ATTACHED` | object must remain available | An accepted message references the upload. | governed by retained receipt/message lifecycle |
| `ABANDONED` | object should eventually be deleted | Upload can no longer become message data. | cleanup policy |

The D1 row is authoritative for whether an upload is attachable. R2 presence alone never makes an object attachable.

`expires_at` represents the active media-state deadline: a new reservation receives the 24-hour `PENDING` deadline, and successful completion extends it to 14 days for `READY`. Attachment does not independently shorten that deadline; retained receipt state governs when attached media becomes safe to delete.

## Upload flow

1. Authenticated device creates a short-lived `PENDING` upload reservation with `POST /v1/media/create`.
2. The reservation binds the upload to the relationship, creating device, media type, size, optional checksum and a server-generated opaque object key.
3. The client uploads the opaque/encrypted object to R2 through the Worker. The body is streamed rather than buffered in Worker memory.
4. `POST /v1/media/{uploadId}/complete` performs an R2 `HEAD` check and verifies object existence, size, MIME metadata, reservation metadata and the optional SHA-256 checksum.
5. Completion atomically transitions `PENDING -> READY` and extends the media deadline to 14 days.
6. Only `READY` uploads can be accepted by message push.
7. Message acceptance atomically creates the mailbox message and transitions the upload `READY -> ATTACHED`.

The reservation response does not expose the R2 object key. The upload API addresses the reservation by `uploadId` and keeps object naming server-controlled.

Completion is idempotent while the upload remains valid `READY`. A repeated completion must never revert `READY` or `ATTACHED`. `ATTACHED` is never accepted as a new completion target.

Invalid or mismatching R2 objects are deleted on a best-effort basis and the D1 reservation remains `PENDING`, allowing a client to retry before the reservation expires. A transient D1 failure after successful R2 validation also leaves the reservation retryable; the object is not deleted merely because the state transition could not be recorded.

Reservation validation is performed before the D1 insert and mirrored by D1 triggers for size and supported MIME invariants. The API currently rejects `DRAWING` reservations until the drawing editor is available.

## Message acceptance

The database acceptance trigger is the final attachment boundary. It verifies relationship/device ownership, `READY` state and expiry before changing the upload to `ATTACHED`. If attachment fails, the mailbox insert and sequence allocation roll back with it.

A `PHOTO_VIDEO` message must reference an upload whose media type is `PHOTO` or `VIDEO`. Other message types cannot reference media. These type invariants are enforced at the D1 boundary as well as by request validation.

## Pull and ACK

Pulling a mailbox message never changes media state and never deletes the R2 object.

The receiver must durably persist both the encrypted message and its referenced media before ACKing through that server sequence. ACK deletes mailbox rows and marks their durable receipts acknowledged; it does not itself delete media.

This separation is intentional: mailbox deletion is not proof that the receiver has durable media unless the receiver follows the protocol's durability boundary.

## Receipts and retries

A durable message receipt survives mailbox deletion and preserves the original `server_seq`, allowing a sender retry after a lost response to remain idempotent.

The production retry contract is finite:

- unacknowledged mailbox messages have a **14-day delivery/retry window**;
- acknowledged durable receipts are retained for **30 days after acceptance**;
- an unacknowledged receipt records the delivery expiry and becomes a retry-expired tombstone rather than silently creating a second acceptance;
- there is no indefinite retry or idempotency guarantee.

Media cleanup must account for both windows. A still-retriable accepted message must not lose the state needed to fulfill its documented guarantee.

Because receipts reference `media_uploads` with `ON DELETE RESTRICT`, media metadata cannot be deleted while a retained receipt references it. Any cleanup implementation must account for this dependency.

## Cleanup

Cleanup will be performed by scheduled Cloudflare Worker work once the R2 integration exists.

Safe cleanup candidates include:

- expired `PENDING` uploads that were never completed;
- `ABANDONED` uploads after their retention window;
- expired `READY` uploads that were never attached;
- `ATTACHED` uploads only after the associated receipt retention period expires.

Cleanup must be:

- retry-safe and idempotent;
- bounded per invocation;
- driven by D1 lifecycle/expiry state;
- ordered so database references and retry guarantees are not broken;
- observable enough to detect stuck uploads or deletion failures.

A failed R2 delete must not corrupt D1 state; a later invocation must be able to retry safely. Cleanup must tolerate an already-missing R2 object.

No cleanup job may delete an R2 object merely because a mailbox message was pulled or ACKed.

## Privacy

Media objects are expected to be opaque encrypted payloads from the application perspective. The server may inspect transport metadata required to enforce size, lifecycle, authorization and routing rules, but it must not require plaintext media content.

The final end-to-end encryption protocol is intentionally deferred until the transport and storage lifecycle are stable.

## Required implementation order

1. Define upload reservation/completion API and validation limits. **Implemented.**
2. Add R2 binding and object-key generation. **Implemented.**
3. Add upload lifecycle tests for retries, ownership, expiry, size/type limits and state transitions. **Core coverage implemented; full cleanup/recovery tests remain.**
4. Implement R2-backed upload completion. **Implemented and hardened.**
5. Integrate attachment with durable message acceptance. **Implemented at the D1 trigger boundary.**
6. Implement scheduled receipt/media cleanup only after the retention contract is covered by tests.
7. Add operational metrics/logging and failure recovery.
8. Connect the React Native sync engine.
9. Add the final E2E encryption layer after the transport/storage contract is stable.
