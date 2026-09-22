# Rucola — Pairing Migration Plan

## Status

This is the implementation contract for replacing the current transitional pairing-payload + five-emojis flow with the intended emoji-only user experience and the alternative share-link transport.

The migration is deliberately incremental. Existing secure pairing, identity, invitation, commitment, expiry, and lifecycle code should be reused wherever its semantics remain correct. The goal is not to rewrite the pairing stack.

## 1. Target product behavior

The pairing UI has exactly one human-facing credential:

> **five emojis**

The user must never be asked to see, copy, paste, compare, type, or manually transfer:

- pairing passes;
- invitation tokens;
- relationship IDs;
- device IDs;
- cloud credentials;
- relationship encryption keys;
- serialized pairing packages;
- technical URLs containing opaque payloads.

There are two user-facing transports.

### Option A — five-emojis

Two phones are beside each other.

~~~text
Phone A
  ↓
shows five emojis

Phone B
  ↓
user enters those five emojis

        ↓
hidden pairing handshake

        ↓
paired
~~~

The five emojis are the pairing password/rendezvous secret. The app performs the rest automatically.

### Option B — share link

The creator presses Share.

The shared URL is designed to look like:

    https://rucola.njco.dev/✨😘😄🤭❤️

The URL path contains the same five-emoji pairing code. No raw relationship key, invitation token, serialized pairing package, cloud credential, or other long opaque payload is put in the visible URL.

On Android, the HTTPS URL should be handled as a verified Android App Link. The website remains the fallback for recipients without the app and must not perform state-changing pairing merely because a browser or link-preview service fetched the page.

The website route is a transport entry point, not a second pairing UI.

## 2. Security model

The five-emoji code and the long-lived relationship key are different things.

### Five emojis

The five-emoji sequence is:

- human-readable;
- short-lived;
- one invitation at a time;
- rate limited;
- one-time consumable;
- suitable as a pairing password/rendezvous secret;
- **not** the application's long-lived encryption key.

The current alphabet has only 33 entries, giving roughly 25 bits of code-space for five positions. That is far too small for a long-lived cryptographic key and should therefore never be stretched directly into the relationship encryption key.

The implementation must use the code only inside a bounded pairing protocol. The hidden protocol must include online attempt limiting and must not create a server-readable copy of the relationship key protected only by this low-entropy code.

### Relationship key

The existing 256-bit relationship encryption key remains the real long-lived secret.

The initiating device generates it locally. The Worker must never receive or store the raw key.

The pairing handshake must establish an authenticated, confidential transport for moving that key from the initiating device to the accepting device. The implementation should use a vetted password-authenticated/key-establishment construction or an equivalent reviewed primitive; Rucola must not invent a home-grown password protocol.

The exact cryptographic primitive/library is a **security gate before implementation of the new handshake**, not something to improvise while wiring screens.

### Threat boundary for v1

The normal cloud service is a relay/state service and must not be able to read the relationship key.

Protection against a compromised endpoint remains outside this milestone.

A future cryptographic hardening phase may replace the prototype key handoff with stronger asymmetric device identity, rotation, and recovery. None of that is required to remove the current user-facing pairing-pass problem.

## 3. Unicode rules

The code is conceptually based on the Unicode representation of the selected emojis, but the implementation must not rely on rendered appearance alone.

Each allowed pairing emoji must have one canonical internal representation. In particular:

- variation selectors must be treated consistently;
- multi-code-point emoji sequences must be treated as one canonical emoji token when they are part of the alphabet;
- Unicode normalization must not silently turn two distinct pairing symbols into different protocol values;
- comparison must operate on canonical token/byte values, not on arbitrary font rendering;
- the exact five-symbol order is significant;
- accidental whitespace may be ignored at the input boundary, but it must never become part of the secret.

The current simple emoji alphabet can remain initially. Expanding it is a separate entropy/UX decision.

The HTTP share-link implementation must decode the URL path exactly once, recover the canonical five-emoji sequence, validate it, and use the canonical protocol representation from that point onward.

Do not compare raw URL strings because Unicode characters may be represented in a URL as UTF-8 percent-encoded octets. See RFC 3987: https://www.rfc-editor.org/rfc/rfc3987.

## 4. Share-link rules

The preferred URL form is:

    https://rucola.njco.dev/<five-emojis>

The technical rules are:

1. The path identifies the short-lived pairing invitation.
2. The URL contains no raw 256-bit relationship key.
3. The URL contains no serialized current pairing package.
4. The URL contains no cloud credential.
5. The URL contains no user/relationship/device identifier unless the identifier is itself intentionally non-sensitive and required for routing.
6. The invitation is short-lived and one-time.
7. GET/HEAD requests never consume the invitation.
8. Actual pairing occurs only after the Rucola app opens the link and performs the pairing protocol.
9. The web response uses no-store, a restrictive Referrer-Policy, and no indexing/analytics that could capture pairing paths.
10. Server-side request/diagnostic logs must not record the full pairing URL or raw five-emoji secret.
11. The route must not become cacheable or shareable as ordinary public content.
12. Invalid, expired, already-consumed, or malformed links return a generic non-sensitive response.

Android should use verified HTTPS App Links for rucola.njco.dev. Android's App Links mechanism associates the domain with the signed app and can route matching HTTPS paths into the app without requiring a custom scheme. See Android App Links: https://developer.android.com/training/app-links.

## 5. Target protocol shape

~~~text
Initiator
  │
  ├─ generate relationship key locally
  ├─ create invitation
  ├─ receive hidden invitation token + credential
  └─ receive five-emojis
          │
          ├────────────── Emoji transport ──────────────┐
          │                                              │
          │        user enters five emojis               │
          │                                              │
          └────────────── Share transport ───────────────┤
                                                           │
                                          link opens in app
                                                           │
                                                           ↓
                                               pairing session
                                                           │
                                      hidden key establishment
                                                           │
                                                           ↓
                                            transfer 256-bit key
                                                           │
                                                           ↓
                                                  accept invitation
                                                           │
                                                           ↓
                                                      ACTIVE
~~~

The existing Worker token should remain an internal invitation capability as long as it is useful for authenticating/looking up the invitation. The user must never handle it.

The new application API should expose pairing intents, not transport-specific secret plumbing to screens.

Conceptually:

~~~text
startPairing()
  → { fiveEmojis, expiresAt, shareUrl }

acceptPairingByEmojis(fiveEmojis)

acceptPairingFromShareLink(url)

  ↓

common PairingSession / PairingManager core
  ↓
hidden protocol
  ↓
CloudIdentityStore + relationship key
~~~

The exact method names can follow the existing code style.

## 6. What stays from the current implementation

Keep and adapt:

- PairingManager;
- CloudRuntime;
- CloudIdentityStore;
- anonymous device identity model;
- relationship-key generation;
- relationship-key commitment;
- Worker invitation creation;
- one-time invitation consumption;
- invitation expiry;
- bounded failed-attempt handling;
- relationship-state transition PAIRING → ACTIVE;
- cloud credential generation/persistence;
- relationship-key persistence in secure local storage;
- server-authenticated relationship-key commitment;
- current pairing-focused tests where their assertions remain valid;
- current reset/cancellation behavior.

The current pairing package serializer may remain as an **internal transport implementation** if it proves useful for the hidden handoff. It must not remain part of the user-facing contract.

## 7. What changes

Remove from the user-facing contract:

- “pairing pass”;
- “share pairing pass”;
- “paste the pairing pass”;
- Quick Share instructions for manually moving a technical payload;
- a second required confirmation field;
- any screen that displays the serialized pairing package;
- explanatory copy that exposes the existence of a connection key.

Change the mobile pairing API from the current package + confirmation acceptance to a transport-neutral acceptance path in which the caller supplies only:

~~~text
five-emojis
~~~

or:

~~~text
share URL
~~~

The hidden session machinery may still use tokens/packages/keys internally.

## 8. Implementation phases

### Phase 0 — protocol/security gate

Before changing the mobile UI:

- define the hidden key-establishment protocol;
- select a vetted implementation/primitive;
- confirm it fits the current Expo/RN/Android stack;
- specify exactly which values are stored server-side;
- confirm the Worker cannot recover the relationship key;
- define transcript/session binding to the invitation;
- define replay protection;
- define expiry and cancellation semantics;
- define how an interrupted pairing resumes or restarts;
- define malformed/invalid/expired URL behavior.

Exit condition:

> The new protocol can be described precisely without requiring any user-visible credential other than the five emojis.

### Phase 1 — transport-neutral pairing core

Refactor the existing pairing implementation without changing the underlying relationship lifecycle:

- separate invitation creation from transport;
- separate hidden protocol state from presentation state;
- keep the relationship-key commitment;
- keep secure identity persistence;
- make PairingManager the single pairing owner;
- introduce a small transport/input abstraction;
- remove pairing-package details from screen types;
- retain compatibility tests for the existing Worker primitives.

Exit condition:

> Screens can request a pairing invitation and receive only the human-facing code plus the link representation.

### Phase 2 — emoji transport

Implement:

- five-emoji input;
- canonicalization;
- hidden server rendezvous;
- hidden key-establishment session;
- relationship-key transfer;
- invitation acceptance;
- pending/retry/cancel/expiry handling.

Tests:

- correct code succeeds;
- one wrong emoji fails;
- reordered emojis fail;
- Unicode representation edge cases resolve correctly;
- expired invitation fails;
- consumed invitation fails;
- repeated attempts are rate limited;
- interrupted handshakes do not create a false ACTIVE local state;
- relationship key commitment still matches after acceptance;
- raw relationship key never enters Worker request payloads.

### Phase 3 — share-link transport

Implement:

- generation of https://rucola.njco.dev/<five-emojis>;
- URL parsing/canonicalization;
- verified Android App Link configuration;
- website fallback page;
- non-consuming GET/HEAD route;
- hidden handoff into the same pairing core;
- one-time consumption only after app-side acceptance.

Tests:

- valid link opens the intended app route;
- malformed Unicode/path data is rejected;
- encoded and displayed Unicode representations resolve to the same canonical code;
- expired links fail;
- consumed links fail;
- browser reload does not consume pairing;
- link-preview requests do not consume pairing;
- raw key/token never appears in the URL;
- server logs do not intentionally capture the pairing path.

### Phase 4 — UI cleanup

The pairing screen should present only the product concept.

Creator:

~~~text
pair with your person

✨ 😘 😄 🤭 ❤️

[ share ]

waiting for them...
~~~

Joiner:

~~~text
pair with your person

[ five emoji input ]

[ connect ]
~~~

Exact copy and visual treatment remain subject to the later Figma pass.

The important invariant is:

> The user sees five emojis as the pairing credential and never sees technical pairing material.

### Phase 5 — remove transitional code

After both transports are proven:

- delete unused pairing-pass UI;
- delete screen-level package handling;
- remove obsolete compatibility paths;
- rename internal types that incorrectly imply user-visible “passes”;
- update tests to target the new transport-neutral contract;
- run a full documentation and secret-surface audit.

## 9. Test matrix

### Core

- invitation creation;
- invitation expiry;
- invitation consumption;
- invitation replay;
- confirmation attempt limit;
- commitment mismatch;
- relationship state transition;
- pending pairing resume;
- reset/cancel;
- app restart during pairing.

### Emoji transport

- exact five symbols;
- duplicate emoji positions;
- different order;
- whitespace;
- variation-selector forms;
- multi-code-point emoji tokens;
- malformed sequences;
- wrong secret;
- retry after transient network failure.

### Share transport

- native app-link launch;
- website fallback;
- encoded Unicode path;
- link preview/crawler GET;
- refresh;
- replay;
- expiration;
- missing app;
- malformed path;
- path logging/redaction.

### Security

- relationship key absent from every Worker request;
- relationship key absent from URLs;
- cloud credential absent from URLs;
- invitation token absent from user-facing UI;
- pairing package absent from user-facing UI;
- pairing URLs marked non-cacheable;
- successful pairing stores the same key commitment on both devices;
- a failed pairing cannot leave a locally ACTIVE relationship.

### Two-device acceptance

The final gate is two physical Android devices using:

1. emoji-only pairing;
2. share-link pairing;
3. restart after pairing;
4. encrypted TEXT exchange;
5. encrypted EMOJI exchange;
6. offline/reconnect;
7. reset.

## 10. Documentation invariants

After this migration, these statements must be true everywhere:

> Pairing uses five emojis.

> Users never see technical pairing credentials.

> The five emojis are a short-lived pairing password/rendezvous secret, not the long-lived relationship encryption key.

> The relationship encryption key is generated and retained by the app and never sent raw to the Worker.

> The share link is an alternative transport and contains only the human-facing five-emoji route, not the raw cryptographic key or serialized pairing package.

Any document that contradicts these statements is stale and must be corrected before implementation is considered complete.

## 11. Migration philosophy

Do not rewrite the cloud pairing system because the UX is wrong.

Keep the secure lifecycle and replace the transport boundary.

~~~text
CURRENT

screen
  ↓
pairing package + five emojis
  ↓
PairingManager
  ↓
Worker

TARGET

screen
  ↓
five emojis OR share link
  ↓
transport adapter
  ↓
common PairingManager
  ↓
hidden key-establishment session
  ↓
existing invitation / identity lifecycle
  ↓
Worker
~~~

The implementation is complete only when the technical complexity still exists where it is needed, but none of it leaks into the user's pairing interaction.
