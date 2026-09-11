# Rucola Pairing Protocol / API Contract

**Status:** core pairing implementation complete; production exposure remains blocked on Cloudflare edge rate limiting and final runtime/deployment review.

## 1. Goal

Pair exactly two devices into one Rucola relationship without making the human-readable pairing code a security credential.

The secure invitation token is the credential. The short confirmation code exists for human confirmation/discovery only.

## 2. Identities and credentials

- `relationship_id` identifies the two-person relationship.
- `device_id` identifies one installation/device.
- future E2E identity is separate cryptographic identity material.
- MVP allows exactly one active device per participant.
- device credentials are random bearer secrets; D1 stores only SHA-256 hashes.
- authenticated device identity determines relationship and participant; request-body identity fields are never authorization inputs.

Pairing does not implement E2E cryptography.

## 3. Initial pairing bootstrap

A completely new first installation has no credential, so the implementation provides:

```http
POST /v1/pairing/bootstrap
Content-Type: application/json
```

Request:

```json
{
  "expiresInSeconds": 86400
}
```

The lifetime is capped at 24 hours.

The server atomically creates:

1. `PAIRING` relationship;
2. first `ME` device;
3. one invitation.

Response:

```json
{
  "relationshipId": "relationship-id",
  "invitationId": "invitation-id",
  "deviceId": "device-id",
  "participant": "ME",
  "credential": "random-bearer-credential",
  "token": "high-entropy-one-time-token",
  "confirmationCode": "123456",
  "expiresAt": 1780000000000
}
```

The raw credential and invitation material are returned only to the caller. They are not stored in plaintext by the server.

The Worker must be protected by a Cloudflare edge rate limit before public exposure because bootstrap is intentionally unauthenticated and creates D1 state. The Worker also applies a separate invitation-specific confirmation-code lockout described below.

## 4. Invitation creation / regeneration

```http
POST /v1/pairing/create
Authorization: Bearer <first-device-credential>
Content-Type: application/json
```

Request:

```json
{
  "expiresInSeconds": 86400
}
```

The authenticated device must be the active `ME` device of a `PAIRING` relationship. The database insert is additionally conditional on the relationship still being `PAIRING`, closing the race where acceptance could activate the relationship between the preliminary read and invitation insert.

Response:

```json
{
  "relationshipId": "relationship-id",
  "invitationId": "invitation-id",
  "token": "high-entropy-one-time-token",
  "confirmationCode": "123456",
  "expiresAt": 1780000000000
}
```

Once any valid invitation is consumed, the relationship becomes `ACTIVE` and all invitations become unusable.

## 5. Invitation acceptance

```http
POST /v1/pairing/accept
Content-Type: application/json
```

Request:

```json
{
  "token": "high-entropy-one-time-token",
  "confirmationCode": "123456"
}
```

Both values are required by the current implementation. The confirmation code is never sufficient without the high-entropy token.

JSON request bodies are capped at 16 KiB before parsing. This endpoint does not accept media or other large request payloads.

Successful response:

```json
{
  "relationshipId": "relationship-id",
  "deviceId": "device-id",
  "participant": "PARTNER",
  "credential": "new-random-bearer-credential"
}
```

The joining device becomes `PARTNER`.

## 6. Confirmation-code brute-force protection

The confirmation code is only six digits, so it cannot be treated as a security credential by itself.

For each invitation:

- failed confirmation attempts are counted transactionally;
- after 5 failed attempts, the invitation is locked for 15 minutes;
- a locked invitation returns `429 PAIRING_RATE_LIMITED` with `Retry-After`;
- the high-entropy token is still required;
- the failed-attempt state does not grant access and does not consume the invitation.

The confirmation-code hash comparison is performed without early exit over the hexadecimal digest.

The server stores only the confirmation-code hash, never the raw code.

## 7. Atomic acceptance

The acceptance path performs a preliminary read only for validation. The actual state transition is guarded inside one D1 batch:

```text
BEGIN
  conditionally insert PARTNER device if invitation is unconsumed + unexpired + unlocked
  conditionally consume invitation for that generated device
  activate relationship only if that invitation was consumed by that device
COMMIT
```

The conditional writes are important because two clients can pass the preliminary validation concurrently.

The active-participant uniqueness constraint provides a second database-level defense against creating two active `PARTNER` devices.

A losing transaction performs no pairing state change and receives `409` after the transaction completes without creating its device.

## 8. Concurrency and replay

Two or more simultaneous accepts of one invitation must produce exactly one second device.

The implementation relies on:

- conditional invitation/device writes;
- conditional relationship activation;
- the database uniqueness constraint on active participants;
- transactional rollback on any batch failure.

Reusing a consumed invitation returns `409 INVITATION_CONSUMED`.

An expired or unknown invitation returns `400 INVALID_INVITATION`.

A wrong confirmation code increments the invitation's failure counter but does not mutate pairing membership or relationship state.

## 9. Input and response hardening

Pairing JSON bodies are bounded to 16 KiB before parsing. This prevents an unauthenticated caller from making the Worker buffer arbitrarily large JSON payloads.

API JSON responses set:

- `Cache-Control: no-store`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`.

The Worker does not log bearer credentials, invitation tokens, confirmation codes, or their plaintext equivalents.

## 10. Error envelope

Worker errors use:

```json
{
  "error": {
    "code": "INVALID_INVITATION",
    "message": "Invalid invitation"
  }
}
```

Relevant cases:

| Condition | HTTP | Error code |
|---|---:|---|
| Missing/invalid authenticated credential | 401 | `UNAUTHENTICATED` |
| Invalid/expired invitation | 400 | `INVALID_INVITATION` |
| Consumed invitation | 409 | `INVITATION_CONSUMED` |
| Confirmation-code lockout | 429 | `PAIRING_RATE_LIMITED` |
| Relationship not pairable | 409 | `PAIRING_CLOSED` |
| Concurrent/state conflict | 409 | `PAIRING_CONFLICT` |
| Malformed/oversized request | 400 | `INVALID_REQUEST` |
| Internal initialization failure | 500 | `INTERNAL_ERROR` |

## 11. Retry/crash semantics

If the joining phone loses a successful acceptance response, retrying the same invitation cannot create another device.

No success is returned until the D1 batch commits.

If the batch fails, invitation consumption, device creation, and relationship activation roll back together.

Invitation creation is not idempotent; retrying it can create another invitation, bounded by expiry and relationship state.

## 12. E2E boundary

Pairing contains no cryptographic protocol beyond hashing bearer credentials and invitation values for server-side lookup.

Future E2E material remains opaque and versioned. The Worker does not decrypt messages, derive message keys, implement a custom ratchet, or use bearer credentials as encryption keys.

## 13. Adversarial test coverage

Implemented in the Worker test suite:

- atomic bootstrap;
- credential hashing rather than plaintext storage;
- valid acceptance;
- exactly two active devices after acceptance;
- invitation consumption metadata;
- replay rejection;
- wrong confirmation code;
- expired invitation;
- invitation regeneration during `PAIRING`;
- ten concurrent acceptance attempts with exactly one success;
- oversized JSON rejection;
- confirmation-code lockout and recovery after lock expiry;
- defensive response headers;
- synchronization endpoints remain `501`.

Still required before production exposure:

- Cloudflare edge rate-limit configuration for the unauthenticated bootstrap endpoint;
- runtime execution of the updated Worker suite in the real checkout;
- final deployment/configuration review;
- another adversarial code review after runtime tests.

## 14. Synchronization boundary

Pairing is implemented. Synchronization remains deliberately inactive:

- `/v1/sync/push` -> `501`;
- `/v1/sync/pull` -> `501`;
- `/v1/sync/ack/:id` -> `501`.

No mobile sync implementation should be built yet.
