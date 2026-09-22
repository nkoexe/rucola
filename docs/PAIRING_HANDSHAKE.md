# Rucola — Hidden Pairing Handshake

## Status

**Prototype implementation complete; not production-ready.** The current adapter is explicitly bound to CPace draft-20 because `@cipherman/pake-js@0.1.1` implements that revision. The active CFRG draft is 21, so this wire format is intentionally versioned as experimental and must not be treated as stable until the dependency/protocol choice is revalidated.

This is the next pairing boundary after the transport-neutral core. It deliberately does not add home-grown PAKE/curve code.

## 1. Step 3 objective

Replace the transitional package + confirmation acceptance path with a hidden pairing session where:

- the user supplies only the canonical five-emoji code;
- the HTTPS share link supplies the same code;
- the Worker is a rendezvous/relay and lifecycle authority, not a cryptographic peer;
- the existing 256-bit relationship key never enters the Worker;
- a wrong code cannot turn a recorded session into the relationship key;
- the relationship reaches ACTIVE only after cryptographic handoff and one-time invitation consumption succeed.

Both user transports terminate in one pairing-session API.

## 2. Primitive decision

Rucola needs a **balanced PAKE** because both phones know the same short-lived pairing secret.

**SPAKE2 (RFC 9382)** is a protocol fit: it is a two-party balanced PAKE, includes key confirmation, and defines a symmetric variant when fixed roles are undesirable. It is nevertheless an Informational RFC, and the repository currently has no clearly suitable maintained SPAKE2 JavaScript/React-Native implementation to adopt blindly. https://www.rfc-editor.org/rfc/rfc9382

**SPAKE2+ (RFC 9383)** is not the default choice. It is an augmented PAKE aimed at client/server verifier-style use, which does not match our peer-to-peer-through-a-relay ceremony. https://www.rfc-editor.org/rfc/rfc9383

**CPace** is a strong architectural fit because it is balanced/composable and designed for two parties sharing a low-entropy secret. The current CFRG draft is revision 21 and is in the RFC Editor process, but it remains a work-in-progress Internet-Draft. https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/

The current JavaScript package `@cipherman/pake-js` exposes Ristretto255/SHA-512 CPace and reports test-vector coverage, but it is pre-1.0 and explicitly says independent audit is still required before production. Its published runtime targets are Node/Deno/Bun/browser; React Native/Expo compatibility therefore needs an actual dev-build probe before adoption. https://www.rfc-editor.org/rfc/rfc9383 and https://github.com/alicommit-malp/pake-js/blob/main/THREAT_MODEL.md

### Gate

The implementation gate is now passed for the repository prototype: CPace draft-20 is wired through the maintained `@cipherman/pake-js@0.1.1` API, with explicit version binding, application-level key derivation, AEAD handoff, confirmation, and a durable Worker relay. Production approval is intentionally still blocked on independent cryptographic review, the library's upstream official-vector suite, and an actual Expo/Hermes Android runtime probe.

The production gate is:

1. verify the dependency against its published draft-20 test vectors and keep the version binding explicit;
2. run the upstream official vectors unchanged as part of dependency review;
3. prove secure randomness and runtime compatibility in the actual Expo/Hermes Android build;
4. review provenance, release history, dependency surface, and failure behavior;
5. re-evaluate the protocol/dependency if CPace draft-21 or an equivalent reviewed implementation becomes the chosen production baseline.

Do not write custom curve arithmetic or a custom PAKE merely to avoid this gate.

## 3. Target protocol

```text
Phone A                         Worker                         Phone B
  │                               │                              │
  │ bootstrap + commitment        │                              │
  │──────────────────────────────>│                              │
  │                               │                              │
  │ five emojis displayed         │<──────── five emojis ────────│
  │                               │                              │
  │                         rendezvous lookup                    │
  │                               │                              │
  │──── PAKE share ──────────────>│──── opaque relay ──────────>│
  │<──── opaque relay ────────────│<──── PAKE share ────────────│
  │                               │                              │
  │        both derive the same PAKE session key                │
  │                               │                              │
  │──── encrypted relationship-key handoff ─────────────────────>│
  │<──────── encrypted finished/confirmation ────────────────────│
  │                               │                              │
  │ local commitment check        │                              │
  │ local identity → ACTIVE       │                              │
```

The Worker must not participate in the PAKE.

## 4. Rendezvous

The five-emoji code is both the human secret and the rendezvous selector.

The server may resolve the invitation using a hash of the canonical code. That hash is **only an online lookup mechanism**; it must not be treated as a cryptographic key.

Therefore:

- invitation/session lifetime stays short;
- lookup and handshake attempts are rate limited;
- invalid and valid lookup failures remain generic;
- relay state is small and expires automatically;
- a successful lookup does not itself create the partner device or activate the relationship;
- no endpoint returns the relationship key or a replayable equivalent.

The existing invitation token remains internal compatibility material until the new flow is complete.

## 5. PAKE inputs

Canonicalize the five emojis once at the input boundary.

Conceptual inputs:

```text
PRS = UTF-8(canonical five-emoji sequence)
sid = fresh per-attempt random session identifier
CI  = fixed Rucola protocol/domain context
AD  = relationship commitment + agreed session/role metadata
```

The exact encoding and KDF inputs must come from the selected PAKE specification/library, not a locally invented variant.

## 6. Relationship-key handoff

Phone A keeps the existing random 256-bit relationship key.

After PAKE succeeds:

```text
PAKE shared secret
        ↓
protocol-defined key derivation
        ↓
temporary pairing transport key
        ↓
AEAD-encrypted relationship-key envelope
        ↓
opaque Worker relay
        ↓
Phone B decrypts locally
        ↓
relationship-key commitment verification
```

The raw relationship key must never appear in Worker JSON, URLs, logs, analytics, rendezvous records, or user-visible errors.

The encrypted handoff must bind the pairing session, protocol version, relationship context, and expected key commitment as authenticated context.

## 7. Completion and failure

ACTIVE is valid only after:

1. PAKE authentication succeeds;
2. Phone B decrypts the relationship key;
3. its commitment matches the Worker-stored commitment;
4. the invitation is consumed exactly once;
5. the local identity is durably stored as ACTIVE.

An interrupted or failed handshake cannot create a locally usable ACTIVE identity.

Existing expiry, cancellation, concurrency, and failed-attempt rules remain authoritative.

## 8. Relay constraints

Pairing-session messages must be narrowly typed and size-bounded.

Each message needs a session identifier, protocol/version marker, role binding, expiry, and replay/ordering semantics.

Unknown versions and malformed envelopes are rejected.

The relay is not a general-purpose blob store.

## 9. Share-link relationship

`https://rucola.njco.dev/<five-emojis>` remains a transport entry point:

```text
HTTPS five-emoji URL
        ↓
canonical code
        ↓
common pairing session
```

GET/HEAD never consumes or activates pairing. The mobile app now handles the HTTPS link through Android App Links when the domain association is configured, and the Worker serves a no-store browser fallback that points into the same pairing core. The App Link association file is emitted only when a real signing-certificate fingerprint is configured.

## 10. Acceptance tests

Primitive:
- official vectors pass unchanged;
- same valid inputs derive the same session material;
- changed input/session produces different material;
- wrong code fails;
- malformed/invalid public shares fail safely;
- replay fails;
- fresh session IDs are independent.

Application:
- raw relationship key is absent from every Worker request;
- raw relationship key is absent from every URL;
- successful handoff preserves the server commitment;
- duplicate completion cannot create a second device;
- expiry and cancellation work;
- restart cannot promote incomplete pairing to ACTIVE;
- pending state remains recoverable only when explicitly valid.

Android:
- secure CSPRNG works on the actual Expo dev build;
- the library runs under Hermes without unavailable platform APIs;
- required native/runtime dependencies build cleanly;
- release build reproduces the same protocol behavior.

## 11. Non-goals

No final key rotation, recovery, multi-device relationships, ratcheting, QR transport, background pairing, or UI redesign in this step.

The existing AES-256-GCM message codec remains separate from the temporary pairing transport key.

## 12. Exit criterion

Step 3 implementation is complete for the prototype. The production exit criterion remains: upstream vector verification, Expo/Hermes runtime validation, independent dependency/security review, exact wire/session-state review, and successful two-device Android pairing through both transports.

Until then, the legacy package path remains compatibility-only and must not return to the user-facing pairing contract.
