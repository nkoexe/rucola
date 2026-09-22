# Rucola — First Online Prototype Plan

**Status:** mobile runtime and foreground encrypted sync implemented; two-device physical validation pending  
**Target:** first real two-device Android prototype against the dev backend  
**Backend:** `https://dev.rucola.njco.dev`  
**Primary branch:** `main` after integration PRs are merged

This document is the implementation plan for the first genuinely online Rucola milestone. It is more specific than `docs/DEVELOPMENT_ROADMAP.md` and should be kept aligned with `docs/ARCHITECTURE.md`, `docs/CLOUD_ARCHITECTURE.md`, and the Worker protocol documentation.

## 1. Milestone definition

The milestone is complete when two real Android devices can:

1. install the same signed dev-test Rucola build;
2. complete local relationship setup;
3. pair the two installations;
4. establish persistent cloud identities;
5. establish a shared relationship encryption key without sending that secret to the server;
6. exchange encrypted `TEXT` and `EMOJI` messages through the dev Worker;
7. preserve every message in local history;
8. correctly maintain the one-active-message-per-participant model;
9. queue messages while one device is offline;
10. reconnect and deliver the queued messages in order;
11. survive app restarts and normal process death;
12. retry safely after ambiguous network failures without duplicate messages;
13. reset/unpair cleanly without leaving usable cloud credentials or encryption secrets behind.

The prototype may still have rough UI. It must not be a technical demo that only works when both devices are online and the app is kept open.

## 2. Current state before implementation

Already present:

- React Native + Expo application foundation;
- local SQLite persistence;
- durable app-owned media;
- typed cloud client;
- backend pairing endpoints;
- backend authenticated sync;
- durable sender sequence/outbox;
- durable pull cursor/inbox;
- idempotent push/ACK handling;
- hardened Worker concurrency and lifecycle behavior;
- dev Worker deployment;
- Android CI build pipeline;
- signed Android release workflow;
- runtime health probe to the dev Worker.

Still missing from the mobile product path:

- two-device physical validation of the integrated path;
- an in-app QR/camera transport (the prototype currently uses the native share sheet);
- signed dev-test APK exercising the complete path on real devices;

The current runtime health probe must not be mistaken for synchronization. It only proves that the app can reach the configured dev Worker.

## 3. Security decision for prototype E2E v1

### 3.1 What is intentionally not being used

The first prototype will **not** use a server-mediated X25519 public-key exchange as its primary E2E mechanism.

A server forwarding each device's public key does not, by itself, authenticate the peer key against a malicious or compromised server. Adding X25519 would therefore add complexity without solving the authentication problem for this milestone.

A full asymmetric identity/key-agreement system, key rotation, or a ratcheting protocol may be introduced later when the product needs those properties.

### 3.2 Prototype mechanism

For E2E v1, the relationship has one cryptographically random **256-bit relationship key**.

Device A creates it locally during pairing.

The relationship key is transferred or established through a hidden pairing session that the Worker cannot read. The user-facing experience has two transports: manual five-emoji entry and the HTTPS five-emoji share link. No technical payload is shown or manually transferred by the user.

The server may receive:

- an invitation identifier;
- a device authentication credential;
- a proof/hash needed to bind the pairing request to the invitation;
- public relationship/device metadata needed for routing.

The server must **not** receive the relationship key itself.

The resulting model is:

```text
Device A
  │
  ├─ generate random 256-bit relationship key
  │
  ├─ create invitation + hidden pairing session
  │
  └─ transfer payload directly to Device B
                           │
                           ▼
                     Device B
                           │
                    stores same key
                           │
          ┌────────────────┴────────────────┐
          │                                 │
       AES-256-GCM                     AES-256-GCM
          │                                 │
      Phone A                           Phone B
          │                                 │
          └──────── ciphertext only ───────┘
                         │
                  Cloudflare Worker
```

This protects message content from the cloud service under the intended server-storage threat model. It does not protect against a compromised endpoint that already has access to the device's secrets.

### 3.3 Message encryption

Use AES-GCM with:

- 256-bit relationship key;
- fresh 12-byte nonce/IV for every encrypted message;
- 16-byte authentication tag;
- authenticated additional data (AAD) binding the ciphertext to its message context.

Expo's current SDK 57 crypto API supports AES-GCM, AES keys up to 256 bits, combined sealed data, and AAD. The current project already uses the SDK 57 `expo-crypto` package line. See the Expo Crypto reference: https://docs.expo.dev/versions/latest/sdk/crypto/ .

A first v1 wire envelope should include at least:

```text
encryptionVersion
nonce / IV
ciphertext
authentication tag
```

The exact serialized envelope must be defined once and tested as a stable protocol.

AAD should bind at least:

```text
relationship identifier
message identifier
message type
sender sequence
encryption version
```

This prevents ciphertext from being silently reused in a different message context.

### 3.4 Secure local storage

Use `expo-secure-store` for small secrets such as:

- cloud credential;
- device ID;
- participant role;
- relationship encryption key.

Do not put these values in AsyncStorage, SQLite, logs, or normal application state persistence.

Expo documents SecureStore specifically for securely storing small values such as tokens and keys. https://docs.expo.dev/develop/user-interface/store-data/

The exact secure-store schema should be hidden behind a small application abstraction so the rest of Rucola does not depend directly on SecureStore.

## 4. Implementation phases

### Phase A — preserve and isolate the crypto/identity foundation

Keep the existing:

- random 256-bit relationship key generation;
- key commitment;
- SecureStore-backed cloud identity;
- cloud credential;
- relationship lifecycle state;
- pairing expiry/cancel/reset;
- encrypted sync runtime.

Add no user-visible pairing credential beyond the five emojis.

### Phase B — introduce a transport-neutral pairing core

Refactor the current PairingManager so screens no longer exchange a serialized pairing package.

Target presentation API:

~~~text
startPairing()
  → fiveEmojis + shareUrl + expiresAt

acceptByEmojis(fiveEmojis)
acceptFromShareLink(url)
~~~

The manager may continue to use the existing invitation token/package internally while the migration is underway.

### Phase C — implement the hidden pairing session

Before coding the handshake, choose and document a vetted password-authenticated/key-establishment construction or equivalent reviewed primitive.

Requirements:

- five emojis authenticate/rendezvous the pairing attempt;
- the relationship key is transferred/established without entering the Worker API;
- replay is rejected;
- failed attempts are bounded;
- the invitation expires;
- interrupted pairing never leaves false local ACTIVE state;
- the final commitment must match.

Do not invent a bespoke low-entropy password protocol.

### Phase D — emoji transport

Creator:

~~~text
start pairing
    ↓
show five emojis
    ↓
wait
~~~

Joiner:

~~~text
enter five emojis
    ↓
hidden pairing session
    ↓
paired
~~~

The user does not see the hidden session, token, key, or package.

### Phase E — share-link transport

Create:

    https://rucola.njco.dev/<five-emojis>

Requirements:

- verified Android App Link;
- exact Unicode/percent-encoding handling;
- website fallback;
- non-consuming GET/HEAD;
- no-store;
- no intentional indexing/analytics;
- pairing-path log redaction;
- hidden handoff into the same pairing core;
- one-time consumption only after app-side acceptance.

### Phase F — remove transitional pairing-pass UX

Delete:

- pairing-pass copy;
- serialized-package input fields;
- Quick Share/manual payload instructions;
- separate confirmation + package acceptance UI.

Keep the package serializer only when it remains useful internally for the hidden protocol; otherwise remove it during cleanup.

### Phase G — two-device validation

Test both transports on physical Android devices, then repeat:

- restart;
- encrypted TEXT;
- encrypted EMOJI;
- offline burst;
- reconnect;
- reset.

A passing unit suite without two-device validation does not complete this milestone.

## 5. Explicit protocol boundaries

### Cloud may know

- relationship ID;
- device ID;
- participant role;
- invitation and authentication state;
- message ID;
- sender/server sequence;
- message type;
- creation/receipt timestamps;
- ciphertext size/hash;
- media metadata required for routing/lifecycle.

### Cloud must not know

- plaintext message body;
- relationship encryption key;
- device's SecureStore contents;
- local message history beyond transient protocol metadata;
- private media decryption material.

### Client owns

- durable history;
- relationship key;
- decrypted message content;
- active-message projection;
- local outbox/inbox state;
- cloud credentials after pairing.

## 6. Recovery semantics

### Lost response after push

The client may retry with the same `messageId + senderSeq + ciphertext metadata`.

The Worker must return the original acceptance instead of creating another message.

### Failure during inbound commit

The pull cursor must not advance and no ACK may cross that boundary.

### Decryption failure

Only the explicitly expected decryption failure path may be classified as discardable. Unexpected codec/runtime failures must stop the affected sync run and preserve the cursor.

### Pairing interrupted halfway

The local state must remain recoverable and retryable. A partially-created server relationship must not leave the app believing it is fully paired.

### Reset

Reset must clear:

- local relationship;
- local messages and app-owned media;
- sync outbox/inbox/state;
- cloud credential;
- device identity;
- relationship encryption key.

A later pairing must create fresh identity/key material.

## 7. Release/build plan for the prototype

The first physical test should use a signed Android release build, not the debug CI artifact.

Recommended tag:

```text
v0.1.0-test.1
```

Build characteristics:

- signed APK;
- dev Worker endpoint;
- no production credentials/resources;
- same release build path used by the eventual release workflow;
- text/emoji online synchronization enabled.

Before installation:

1. Android release workflow is green.
2. APK signature verification passes.
3. Worker dev health check is green.
4. Worker migrations are current.
5. No production endpoint is configured.
6. No debug build is being published by the release job.

## 8. Manual two-device test procedure

### Preparation

- Device A: fresh app install;
- Device B: fresh app install;
- both have network access;
- both have never been paired to the test relationship;
- record the exact APK version/tag.

### Pair

1. Open A.
2. Complete local setup.
3. Start pairing.
4. Either enter the five emojis on B, or open the shared HTTPS five-emoji link on B.
5. Let the hidden pairing session complete; no technical payload is entered by the user.
6. Complete pairing on B.
7. Restart both apps.
8. Verify both still show paired state.

### A → B

1. Send TEXT from A.
2. Verify immediate local display on A.
3. Wait/sync B.
4. Verify B receives the exact text.
5. Verify it is partner-active on B.
6. Verify the message exists in local history.
7. Restart B and verify it remains.

### B → A

Repeat in the opposite direction.

### Offline burst

1. Disconnect B from the network.
2. Send three messages from A.
3. Confirm A remains usable.
4. Reconnect B.
5. Run/trigger synchronization.
6. Verify all three messages arrive in the original order.
7. Verify only the newest is active.

### Retry/crash

1. Start a send.
2. Interrupt network/process at an inconvenient point.
3. Restore network.
4. Verify exactly one message exists after recovery.

### Reset

1. Reset one test relationship.
2. Verify local cloud identity/key material is gone.
3. Pair a fresh relationship.
4. Verify fresh synchronization works.

## 9. Observability for the first test

Do not log message content, credentials, relationship keys, invitation secrets, or decrypted media.

Safe diagnostic information may include:

- sync start/end;
- number of pushed/pulled/acknowledged messages;
- retry category;
- HTTP status/code;
- current sync cursor;
- device-role state;
- pairing state;
- Worker version.

Diagnostics must never make secrets reconstructible from logs.

## 10. Scope after first successful online prototype

Immediately after the first successful two-device test:

1. fix every physical-test failure before adding features;
2. add robust background/notification behavior;
3. finish photo/video synchronization;
4. implement drawing end-to-end;
5. perform full E2E/key-management security review;
6. then proceed toward the Figma/UX implementation.

Do not add widgets, statistics, reactions, replies, read receipts, multiple relationships, or conventional accounts to the critical path for this milestone.

## 11. Exit criteria

The milestone is **not complete** merely because one message arrived once.

All of these must be true:

- two fresh devices can pair;
- pairing survives restart;
- the cloud credential survives restart;
- the relationship key survives restart;
- TEXT works in both directions;
- EMOJI works in both directions;
- offline bursts work;
- retries do not duplicate messages;
- inbound state is transactionally durable;
- ACK occurs only after local durability;
- ciphertext tampering is rejected;
- reset removes secrets;
- signed dev APK can be installed on both devices;
- dev backend remains isolated from production;
- tests and CI are green.

## 12. Review checkpoints

Every phase should end with:

- code inspection;
- targeted unit tests;
- integration tests where practical;
- adversarial/error-case review;
- cleanup pass;
- documentation update;
- explicit statement of what was actually validated.

Do not mark a phase complete based only on compilation.

## 13. Decision record

The important design decisions captured by this plan are:

1. **SQLite remains the durable local source of truth.**
2. **The cloud is a temporary mailbox, not permanent history.**
3. **Cloud authentication credentials and message-encryption material are separate secrets.**
4. **Prototype E2E uses a random 256-bit relationship key.**
5. **The relationship key must be transferred/established through the hidden pairing session and never sent raw to the Worker.**
6. **AES-256-GCM is the message encryption primitive for E2E v1.**
7. **AAD binds encrypted content to message identity/context.**
8. **The server never needs plaintext.**
9. **The existing durable outbox/pull-cursor/ACK semantics remain the synchronization backbone.**
10. **TEXT/EMOJI are the only synchronized message types required for the first two-device milestone.**
11. **PHOTO_VIDEO and DRAWING stay blocked until their complete synchronization paths exist.**
12. **The application owns one CloudRuntime rather than allowing screens to construct independent sync clients.**
13. **The user-facing pairing interaction stays simple and human; technical credentials remain invisible.**

## 14. Relationship to other documentation

- `docs/PRODUCT_SPEC.md` — product behavior and scope;
- `docs/DEVELOPMENT_ROADMAP.md` — phase-level project roadmap;
- `docs/ARCHITECTURE.md` — current cross-layer architecture and invariants;
- `docs/CLOUD_ARCHITECTURE.md` — Worker/D1/R2 protocol architecture;
- `cloud/worker/README.md` — current Worker implementation/deployment notes;
- this document — concrete implementation plan for the first online two-device milestone.

When an implementation decision changes, update the authoritative document first and keep this plan synchronized.
