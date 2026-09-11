# Rucola Cloud Protocol Review / C1

**Status:** complete
**Branch:** `cloud/research`

C1 adversarially reviewed the mailbox protocol before backend implementation. The review covered concurrent sends, retries, local crashes, ACK loss, offline bursts, out-of-order HTTP, media races, pairing races, reinstall/revocation, retention, poison messages, relationship end, and future E2E boundaries.

## Hard invariants confirmed

- `message_id` is client-generated and stable across retries.
- `sender_seq` is durable per sender device. A sequence cannot identify two different messages.
- `server_seq` is allocated transactionally per relationship only for genuinely new messages.
- Exact duplicate pushes and ACKs are idempotent.
- Reusing a sender sequence for another message is a protocol conflict.
- Recipient cursor advancement happens in the same local SQLite transaction as durable message persistence.
- ACK follows durable local persistence and required media durability; it is not a read/seen signal.
- Media has an independent upload lifecycle before message attachment.
- Invitation consumption and second-device creation are atomic.
- The secure invitation token is the credential; the human code is confirmation/discovery only.
- Device authentication identity is separate from the future E2E cryptographic identity.
- Bounded pull batches and a recoverable poison-message path prevent one bad message from permanently blocking synchronization.

## Important correction from C1

A first media design attempted to make media metadata depend on a mailbox message that did not yet exist. That creates a lifecycle contradiction because the R2 upload must be prepared before the message can be accepted.

The corrected model is:

```text
media upload -> PENDING -> READY -> mailbox attachment -> ATTACHED
```

The mailbox row references the media row; the media row does not require a mailbox row to exist first.

## Failure scenarios checked

### Concurrent sends
Two devices may send concurrently. There is no honest shared creation timestamp. The server assigns deterministic acceptance order through `server_seq`.

### Offline burst
A sender can create A/B/C locally and later upload them in sender sequence order. The server accepts gaps and out-of-order HTTP arrival; the client remains responsible for preserving sender sequence.

### Retry after uncertain response
The stable `message_id` makes a retry safe. If the original commit succeeded but the response was lost, the retry returns the existing `server_seq` rather than creating a second message.

### Crash around local persistence
The client advances its sync cursor only in the same SQLite transaction that applies the incoming message. A crash before commit causes a safe retry; a crash after commit cannot lose the cursor/message pairing.

### ACK loss
ACK is idempotent. Repeating it does not mutate message content or create duplicate state.

### Media races
R2 operations happen outside D1 transactions. D1 only attaches media after the upload is verified READY. Concurrent attachment attempts are rejected by conditional state transition and unique media reference.

### Pairing races
Invitation consumption, second-device creation, and relationship activation are one transaction, with the active-device uniqueness constraint as a second defense.

### Reinstall
A reinstall creates a new device identity and therefore a new sender-sequence namespace. Reusing an old sequence namespace without recovery would be unsafe.

### Relationship end
`ACTIVE -> ENDED` blocks new message acceptance. Already accepted mailbox rows are not retroactively erased by the state transition; normal delivery/retention rules continue to govern them.

### Poison messages
A malformed or permanently invalid mailbox item must not cause the pull cursor to advance past it forever. Client sync therefore needs a bounded retry/permanent-invalid path before production rollout.

## Outcome

C1 is considered complete. C2 translated these invariants into the concrete D1 schema. C3 provides only the Worker/runtime skeleton; it deliberately does not pretend to implement the full synchronization protocol yet.
