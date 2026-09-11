# Rucola Pairing Protocol / API Contract

**Status:** contract frozen; endpoints remain `501 Not Implemented` until implementation and tests are ready.

## 1. Goal

Pair exactly two devices into one Rucola relationship without making the human-readable pairing code a security credential.

The secure invitation token is the credential. The short confirmation code exists for human confirmation/discovery only.

The protocol must be safe against replay, guessing, expiry races, concurrent acceptance, duplicate requests, and client crashes.

## 2. Identities

There are three separate concepts:

- `relationship_id` — identifies the two-person relationship.
- `device_id` — identifies one authenticated installation/device.
- future E2E identity — cryptographic identity used by the encryption protocol.

The Worker must not derive E2E identity from bearer credentials and must not invent cryptographic key agreement as part of pairing.

The MVP allows exactly one active device for each participant.

## 3. Credential model

Each device receives a random bearer credential during creation.

The server stores only:

```text
SHA-256(credential)
```

The raw credential is returned only over the authenticated pairing response and is not stored in D1.

Authentication uses:

```http
Authorization: Bearer <credential>
```

The authenticated device row determines `relationship_id` and `participant`. A request body must never be trusted to select a participant.

Credential requirements:

- cryptographically random;
- sufficient entropy for an unguessable bearer secret;
- never logged;
- never placed in URLs;
- revoked devices immediately fail authentication.

## 4. Invitation creation

### Endpoint

```http
POST /v1/pairing/create
Authorization: Bearer <first-device-credential>
Content-Type: application/json
```

### Request

```json
{
  "expiresInSeconds": 86400
}
```

The server may ignore or clamp the requested lifetime to the configured maximum. The protocol default is approximately 24 hours.

No relationship ID is accepted from the client for authorization. The authenticated device's relationship is authoritative.

### Successful response

```http
201 Created
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "relationshipId": "relationship-id",
  "invitationId": "invitation-id",
  "token": "high-entropy-one-time-token",
  "confirmationCode": "123456",
  "expiresAt": 1780000000000
}
```

The token is a credential and must be delivered only through a protected channel. The confirmation code can be shown to the user or encoded in a QR/deep link, but the code alone must not authorize acceptance.

### Creation transaction

The endpoint must perform these operations atomically:

```text
BEGIN
  verify authenticated device is active
  verify relationship is ACTIVE or otherwise explicitly eligible to invite
  create invitation with token hash + confirmation-code hash
COMMIT
```

For a first-time relationship bootstrap, relationship creation and first-device creation are also atomic:

```text
create relationship(PAIRING)
create first device
create invitation
COMMIT
```

The exact bootstrap route may be introduced separately; it must not leave a half-created relationship or device.

## 5. Invitation acceptance

### Endpoint

```http
POST /v1/pairing/accept
Content-Type: application/json
```

### Request

```json
{
  "token": "high-entropy-one-time-token",
  "confirmationCode": "123456",
  "deviceName": "optional-local-label"
}
```

`confirmationCode` is optional for transport if the product uses it only for local UI confirmation, but when supplied it must be checked against the invitation. It is never sufficient without the token.

The server must not accept a relationship ID supplied by the joining device as proof of authorization.

### Successful response

```http
201 Created
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "relationshipId": "relationship-id",
  "deviceId": "device-id",
  "participant": "PARTNER",
  "credential": "new-random-bearer-credential"
}
```

The joining device becomes the second participant. The returned credential is shown only once to the client and is never stored in plaintext by the server.

## 6. Acceptance transaction

Invitation acceptance is one database transaction:

```text
BEGIN
  find invitation by token_hash
  verify invitation exists
  verify expires_at > server_now
  verify consumed_at IS NULL
  verify relationship is PAIRING
  verify exactly one active device exists
  create second device with new credential hash
  mark invitation consumed with consumed_at + consumed_by_device_id
  change relationship PAIRING -> ACTIVE
COMMIT
```

If any step fails, the entire operation rolls back.

The server must generate the second device identity and credential; the client cannot choose an existing `device_id`.

## 7. Concurrency rule

Two simultaneous acceptance requests using the same invitation must result in exactly one success.

The losing request must receive a stable conflict such as:

```http
409 Conflict
```

It must not create a third device, reactivate a consumed invitation, or partially modify the relationship.

The database uniqueness constraint on active participant devices is a second line of defense; correctness must not rely solely on application timing.

## 8. Expiry and replay

Invitation validity is based on server time.

An invitation is invalid when:

- its token does not match;
- it has expired;
- it has already been consumed;
- the relationship is no longer in `PAIRING` state;
- the relationship already has the required second active participant.

A consumed invitation remains stored for audit/diagnostic purposes until normal cleanup. Consumption is not undone by a client retry.

The token must be one-time-use.

## 9. Error contract

The API uses a stable JSON error envelope. Exact HTTP mapping should remain consistent with the Worker-wide error policy.

Minimum protocol-level cases:

| Condition | HTTP | Error code |
|---|---:|---|
| Missing/invalid credential on authenticated route | 401 | `UNAUTHENTICATED` |
| Expired/invalid invitation | 400 or 404 | `INVALID_INVITATION` |
| Invitation already consumed | 409 | `INVITATION_CONSUMED` |
| Relationship no longer pairable | 409 | `PAIRING_CLOSED` |
| Active participant/device conflict | 409 | `PAIRING_CONFLICT` |
| Malformed JSON/request | 400 | `INVALID_REQUEST` |
| Unexpected database failure | 500 | `INTERNAL_ERROR` |
| Rate limit | 429 | `RATE_LIMITED` |

The implementation may collapse externally visible invitation errors to reduce enumeration, but must preserve unambiguous internal semantics and tests.

## 10. Rate limiting

Pairing endpoints must be rate limited before production exposure.

At minimum, acceptance attempts should be limited by a combination of network/client characteristics and invitation identifier/token-derived material without storing raw tokens.

Rate limiting must not be used as the only protection: the token remains high entropy and the confirmation code is not an authentication factor.

## 11. Crash and retry semantics

### Client crashes after successful acceptance

A retry with the same invitation must not create another device. The invitation is already consumed.

The client needs a recovery UX for the case where the server succeeded but the response was lost. The protocol must not solve this by making the invitation reusable.

### Duplicate create request

Invitation creation is not required to be idempotent in the first contract. A retry may create a new invitation, provided old invitations remain independently bounded by expiry.

If a later client UX needs create-idempotency, add an explicit client idempotency key rather than guessing from timestamps.

### Server/database failure

No externally visible success may be returned until the pairing transaction commits.

If the transaction rolls back, no device or invitation may be partially consumed.

## 12. Participant assignment

The first device is `ME` and the joining device is `PARTNER` for the MVP.

The server derives this from relationship state, not from a client-provided participant field.

The invitation creator must be an active member of the relationship. A revoked device cannot create or accept pairing operations requiring authentication.

## 13. E2E boundary

Pairing implementation does **not** implement encryption.

The Worker treats future E2E public keys, identity material, and message ciphertext according to an explicit versioned opaque-payload contract. It does not:

- decrypt message content;
- derive message keys;
- invent a custom ratchet;
- interpret ciphertext structure beyond protocol validation;
- use bearer credentials as encryption keys.

A later E2E design will define the cryptographic protocol and key lifecycle after Expo/React Native compatibility has been researched.

## 14. Pairing adversarial test matrix

These are required tests before enabling the endpoints. The current Worker must continue returning `501` until the implementation is ready.

### Invitation lifecycle

1. Create invitation from active first device -> exactly one invitation exists.
2. Create invitation from revoked device -> rejected.
3. Create invitation for an ended relationship -> rejected.
4. Accept valid invitation -> exactly two active devices and relationship becomes `ACTIVE`.
5. Accept expired invitation -> rejected; no device created.
6. Accept unknown token -> rejected; no database mutation.
7. Accept already-consumed token -> conflict; no second device.
8. Accept invitation after relationship becomes ended -> rejected.

### Credential security

9. Stored credential is a hash, not plaintext.
10. Random credential values are not repeated across device creation.
11. Revoked credential cannot authenticate.
12. A credential for one relationship cannot authenticate as another relationship/device.
13. Client-supplied participant or relationship ID cannot override authenticated identity.

### Replay/concurrency

14. Two simultaneous accepts of one invitation -> one success, one conflict.
15. Ten simultaneous accepts of one invitation -> still exactly one second device.
16. Retry after a successful accept with a lost response -> no new device.
17. Reusing a consumed token with a different confirmation code -> rejected.
18. Correct token with incorrect confirmation code -> rejected when code checking is enabled.
19. Expiry boundary is evaluated using server time, not client time.

### Crash/rollback

20. Failure during second-device creation -> invitation remains unconsumed and relationship remains `PAIRING`.
21. Failure during invitation consumption -> second device creation rolls back.
22. Failure during relationship activation -> all pairing writes roll back.
23. No successful HTTP response is returned for a transaction that did not commit.

### Enumeration / abuse

24. Invalid-token flood is rate limited.
25. Expired-token flood is rate limited.
26. Invitation token is never placed in logs, URLs, or error messages.
27. Error responses do not expose credential hashes or raw token material.

### State integrity

28. The active-device uniqueness constraint remains intact under concurrent acceptance.
29. A revoked first device cannot create another active invitation if policy forbids it.
30. A relationship cannot transition back from `ACTIVE` to `PAIRING` through the acceptance endpoint.
31. Consumed invitation records remain internally consistent (`consumed_at` and `consumed_by_device_id` are both set).

## 15. Frozen implementation boundary

Until these tests and transaction semantics are implemented and passing:

- `/v1/pairing/create` stays `501`;
- `/v1/pairing/accept` stays `501`;
- `/v1/sync/push` stays `501`;
- `/v1/sync/pull` stays `501`;
- `/v1/sync/ack/:id` stays `501`.

No mobile sync implementation should be built against an unstable pairing contract.
