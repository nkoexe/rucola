# Rucola Message Ordering Contract

**Status:** protocol decision frozen before pairing/sync endpoint implementation.

## 1. The key distinction

Rucola has three different notions of order. They must not be conflated:

1. **Local insertion order — `orderIndex`**
   - Owned by each phone's local SQLite database.
   - Monotonically increases when that phone persists a message.
   - It is the authoritative order of that phone's local history record.
   - It is never treated as a distributed sequence and is never compared across devices.

2. **Sender order — `sender_seq`**
   - Owned by the originating device.
   - Monotonically increases for that device's outbound messages.
   - It proves the relative order of messages created by one device.
   - Gaps and out-of-order server arrival are valid.

3. **Mailbox acceptance order — `server_seq`**
   - Allocated by the server once, transactionally, when a new message is accepted.
   - Unique and monotonically increasing within a relationship.
   - It orders mailbox delivery, not the historical creation time of messages.

There is deliberately no claim that two independently offline devices can discover a single true creation order after the fact. If A and B create messages concurrently, neither phone can know which was "first" without inventing a rule.

## 2. Offline example

Consider:

```text
A is offline:
  A1  sender_seq=1
  A2  sender_seq=2

B is offline:
  B1  sender_seq=1
```

Suppose the network later delivers them to the Worker in this order:

```text
B1 -> A2 -> A1
```

The server might therefore allocate:

```text
B1 -> server_seq=1
A2 -> server_seq=2
A1 -> server_seq=3
```

This is valid. `server_seq=1` does not mean B1 was created before A1 or A2. It means B1 was accepted first by the mailbox.

A2 arriving before A1 is also valid. The server does not require sender sequences to arrive contiguously.

## 3. What happens locally

When A creates A1 and A2 while offline:

```text
A1 -> local orderIndex=101
A2 -> local orderIndex=102
```

When B creates B1:

```text
B1 -> local orderIndex=77
```

Those values are local-only. They must never be copied from one phone to the other and must never be interpreted as global conversation positions.

When A later receives B1 from the server, A inserts B1 using the next locally available `orderIndex`, for example:

```text
A1 -> 101
A2 -> 102
B1 -> 103
```

If B receives A2 and A1 in that server order, B may have:

```text
B1 -> 77
A2 -> 78
A1 -> 79
```

The local rows are immutable message records, but the two phones' local insertion order can legitimately differ because they observed the distributed system at different times.

## 4. Why `server_seq` is not conversation order

`server_seq` is **transport/mailbox ordering only** in the first protocol version.

It must not silently become a claim about when a message was created or what the users meant as the conversational order. In particular:

- `server_seq=10` does not mean the message was created after `server_seq=9`.
- It does not repair concurrent offline ordering.
- It does not override the originating device's `sender_seq`.
- It is the cursor used to ask the mailbox for messages after a known point.

This is intentional because making `server_seq` the conversation order would require a second local policy for messages that were already displayed offline and are later discovered to have lower/higher server positions. That would make the UI rewrite its presentation order after synchronization.

Rucola instead accepts that local history is an observation of the conversation from that device's perspective. The permanent message records are identical once synchronized; their local insertion positions need not be.

## 5. No immutable-history rewrite

Remote delivery must never rewrite an existing message's immutable fields:

- `message_id`
- sender identity
- `sender_seq`
- message type
- encrypted payload
- client creation timestamp
- media reference

A remote message is inserted as a new local history row and receives a new local `orderIndex`.

The only local metadata that may change as part of normal synchronization is delivery state and related sync bookkeeping. `orderIndex` is not retroactively reassigned to make the server's receipt order fit an already displayed history.

## 6. Sender ordering still matters

`sender_seq` gives us a stable ordering relationship for messages from the same originating device.

For the example above:

```text
A1 sender_seq=1
A2 sender_seq=2
```

Even if A2 reaches the server first, the server knows that A2 belongs after A1 in A's own sequence. It does **not** need to reject A2 or wait for A1.

This distinction is important for offline delivery: a missing earlier request must not block later messages forever.

The client can detect a sender-sequence gap if it wants diagnostics or repair logic, but the mailbox cursor must continue to advance normally.

## 7. Pull and burst delivery

The pull API remains:

```text
GET /v1/sync/pull?after=<last_durable_server_seq>&limit=<bounded-limit>
```

The Worker returns accepted mailbox messages in ascending `server_seq` order.

For a burst such as:

```text
server_seq 20 -> A2
server_seq 21 -> A1
server_seq 22 -> B1
```

the client processes the batch in that order. It does not wait for sender sequence 1 before persisting sender sequence 2.

The entire applicable batch may be committed in one local SQLite transaction, or split into bounded transactions if the mobile implementation needs to cap transaction size. In either case, the durable cursor only advances through messages that were actually persisted.

If local persistence fails halfway through a batch, the cursor must remain at the last committed position. The next pull safely returns the uncommitted messages again.

## 8. HTTP response order does not matter

Push requests can complete in any network order. The server sequence is allocated at acceptance time, not from client timestamps and not from request creation time.

Example:

```text
A creates A1, A2 offline.
A sends A1 and A2 concurrently.
A2 reaches the Worker first.

A2 -> server_seq=50
A1 -> server_seq=51
```

This is valid. Retrying A1 later must return `server_seq=51`; it must never receive a new sequence.

## 9. Reinstall / new device

A reinstall is a new device identity in the MVP.

The new installation must not continue the old device's `sender_seq` namespace. It receives a new `device_id` and therefore a new sender-sequence namespace.

This prevents a restored or reset local counter from colliding with messages already accepted under the old device identity.

If recovery of an old device's unsent messages is ever required, that needs an explicit recovery protocol. It must not be approximated by resetting a sequence counter.

## 10. What this guarantees

The frozen contract guarantees:

- local offline sends never need to be renumbered because another device was offline;
- messages from one sender have a durable sequence;
- every accepted message has one immutable server mailbox position;
- retries do not create new positions;
- out-of-order HTTP delivery is valid;
- offline bursts can be delivered without blocking on missing earlier sender sequences;
- sync can resume from a durable mailbox cursor;
- no message body/history row needs to be rewritten after remote delivery.

It intentionally does **not** guarantee that two phones will render concurrent offline messages in the same historical order. There is no factual global creation order available for those concurrent events.

## 11. Future canonical conversation ordering

If a future product requirement demands that both phones eventually display exactly the same total conversation order, that is a separate protocol decision. It would require an explicit deterministic ordering rule and a presentation layer capable of placing newly learned messages into that order.

It must not be achieved by pretending that `server_seq` is creation order.

For the current product, local append-only history plus server mailbox ordering is the simpler and more honest model.
