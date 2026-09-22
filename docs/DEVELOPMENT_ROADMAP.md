# Rucola — Development Roadmap

This roadmap translates the product direction into development phases. It is intentionally ordered so that the application can reach a rough real online prototype while functionality and backend work advance together.

## Current baseline

`main` contains the React Native/Expo migration, local SQLite repository, durable media handling, schema migrations and native integration coverage, typed cloud protocol/client foundations, durable local sync state, and a hardened mobile sync engine.

Current foundation status:

- React Native / Expo foundation: complete
- local persistence: complete
- core message lifecycle: complete
- media picker/camera persistence: complete
- SQLite migrations: complete
- native integration harness: complete
- durable mobile sync state: complete
- mobile SyncEngine push/pull/ACK foundation: complete
- Android CI build pipeline: complete
- final navigation architecture: not complete
- final Home UX: not complete
- three-day stale Home behavior: not complete
- real two-device application pairing: not complete
- application-level cloud credential persistence/lifecycle: complete
- first application-owned encrypted SyncEngine runtime: complete
- end-to-end online message exchange: pending two-device validation
- pairing migration: transport-neutral boundary complete; hidden handshake gate prepared
- final Figma implementation: not started

The cloud workstream is on `cloud/research`. Its current Worker implementation already covers the core transport foundation, including pairing, directional mailbox synchronization, receipts, media/R2 handling, cleanup, bounded payloads, and concurrency hardening. That work is ahead of the stable mobile integration on `main` and should not be described as merely a proposed backend.

## Phase 1 — Application structure and lifecycle hardening

Goal: make the current local app clean enough that new product functionality does not accumulate presentation-layer hacks.

### Work

- migrate hand-rolled screen enum/callback navigation to Expo Router;
- keep actual feature screens under `src/screens/` where practical;
- use route files as routing boundaries rather than duplicating screen implementations;
- establish a small application bootstrap/context layer;
- centralize repository initialization and relationship loading;
- centralize refresh/invalidation behavior;
- remove prototype-only test controls from normal Home UX;
- make Home, History, Calendar, and Settings lifecycle behavior consistent;
- move history semantics out of screen-level filtering where appropriate;
- review `Message.isActive` as a domain projection of active-slot state;
- preserve current repository/domain boundaries;
- avoid introducing Redux, Zustand, React Query, MobX, or an event bus unless a demonstrated requirement appears.

### Review requirements

Every implementation step must include a code review/cleanup pass and an edge-case audit.

Do not expand SQLite unless the audit finds a real defect.

### Exit criteria

- routing is predictable;
- app initialization has one clear owner;
- screens do not each invent their own application lifecycle;
- navigation is ready for future deep links/pairing routes;
- existing domain/native tests still pass;
- Android CI remains green.

## Phase 2 — Complete local product loop

Goal: make Rucola a complete local product before worrying about visual perfection.

### User journey

```text
Open
 ↓
Logo
 ↓
Pair/setup
 ↓
Partner name
 ↓
Your name
 ↓
Together since
 ↓
Home
 ↓
See partner message
 ↓
Send something
 ↓
Message replacement/history
```

### Work

- finalize onboarding step order and transitions at the interaction level;
- implement the intended Home interaction;
- make send affordance simple and deliberate;
- text sending;
- emoji sending;
- photo/video sending;
- camera flows;
- restart/persistence behavior;
- Home empty/waiting state;
- three-day stale-message behavior;
- History timeline;
- Calendar day filtering;
- Settings/reset behavior;
- media failure cleanup;
- error/retry states;
- no-data and first-message states;
- remove or clearly gate intentionally unavailable drawing behavior;
- resolve any remaining presentation/documentation discrepancies before the Figma pass.

### Exit criteria

A fresh local installation can complete the whole **local** experience without developer-only controls.

The message lifecycle works for bursts and restarts:

```text
A → B → C
```

without losing history or incorrectly showing an old active message.

## Phase 3 — Backend and synchronization foundation in parallel

Backend work proceeds in parallel with the local/mobile phases. It does **not** wait for pixel-perfect UI.

Goal: create the minimum real transport required for two anonymous installations to pair and exchange messages reliably.

### Backend direction

Current production direction:

- Cloudflare Workers — API/orchestration;
- D1 — relationship/metadata state and temporary mailbox;
- R2 — temporary media mailbox/storage.

The backend is a temporary mailbox, not permanent history storage. Local SQLite remains the durable source of truth.

### Implemented on `cloud/research`

- device-bound authentication;
- two-person relationship state machine;
- pairing bootstrap, invitation creation, and acceptance;
- invitation expiry and bounded confirmation attempts;
- stable client message identity and idempotent push retries;
- durable sender sequence and server sequence handling;
- durable message receipts;
- directional mailbox pull that excludes the requesting device's own messages;
- directional ACK that only acknowledges partner-originated messages;
- atomic message-acceptance invariants;
- media attachment/type invariants;
- bounded photo/video uploads using fixed-length streaming;
- media completion and R2 lifecycle;
- mailbox/media/receipt cleanup;
- mailbox expiry and cursor-gap handling;
- concurrent ACK/pairing/message lifecycle hardening;
- regression coverage for two-device, cursor-gap, media lifecycle, and concurrency behavior.

### Implemented on `main`

The mobile repository/data layer and sync client foundation now provide:

- typed `CloudClient` for auth, pairing, push, pull, ACK, and media endpoints;
- durable per-device sync state in SQLite;
- durable sender sequence allocation and outbox state;
- bounded retry handling with terminal handling for unsupported/blocked work;
- inbound cursor advancement only after local durable commit;
- post-commit ACK behavior;
- sender/participant/message identity validation;
- explicit handling for expected undecryptable inbound messages without permanently blocking later sequences;
- preservation of local history when synchronization fails.

This is now the first application-owned online runtime, but it is not yet the completed two-device prototype. The runtime owns the cloud client, persisted identity/key material, AES-GCM codec, SQLite sync state, and SyncEngine. TEXT/EMOJI synchronization is triggered on startup, after pairing, after local message creation, and on Android foreground resume. Media synchronization remains intentionally incomplete, and two physical Android devices still need validation.

### Remaining backend/workstream work

1. Keep the hardened Worker implementation and stable mobile contract aligned.
2. Introduce a transport-neutral pairing core that preserves the existing invitation, commitment, identity, expiry, and lifecycle machinery.
3. Choose and implement a vetted hidden key-establishment/password-authenticated pairing construction so the five emojis are the only human-facing credential while the 256-bit relationship key remains protected from the Worker.
4. Implement emoji-only pairing: entering the five canonical emojis is sufficient; no pairing pass/package is requested from the user.
5. Implement the HTTPS share-link transport using https://rucola.njco.dev/<five-emojis>, Android App Links, and a non-consuming web fallback.
6. Audit Unicode canonicalization, percent-encoding, link-preview behavior, caching, analytics, and log redaction for pairing links.
7. Remove transitional pairing-pass UI and package handling from the presentation layer.
8. Validate both pairing transports on two physical Android devices, including restart, expiry, retry, reset, and key-commitment checks.
9. Keep the 14-day mailbox / 30-day durable-receipt retention contract aligned between Worker code, tests, and client behavior.
10. Finish end-to-end photo/video synchronization after TEXT/EMOJI online sync is proven.
11. Add later E2E hardening such as key rotation/recovery only after the first encrypted two-device prototype works.
## Phase 4 — First usable online prototype

This is the major halfway milestone and the first real product checkpoint.

### Definition

Two real people can use two real Android devices and:

- install the same signed dev-test APK;
- complete anonymous local setup;
- pair using **only the five-emojis user-facing credential**;
- use either manual five-emoji entry or the HTTPS share link;
- complete the hidden key-establishment step without exposing the relationship key to the Worker;
- persist the resulting cloud credentials and encryption key locally;
- exchange encrypted TEXT and EMOJI messages over the Internet in both directions;
- queue multiple outbound messages while the other person is offline;
- reconnect and recover the complete ordered message history;
- preserve the one-active-message-per-participant model;
- continue using the app after restart or normal process death;
- retry safely after ambiguous network failures without creating duplicate messages;
- reset the relationship and remove local cloud/encryption secrets.
### Prototype quality

The UI may still be rough. The share action uses the native Android share sheet for the HTTPS five-emoji link; the user is never asked to share a technical pairing payload.

The prototype is successful only when both pairing transports and the central relationship loop work across two real devices, not merely in unit tests or on one device.

The exact test matrix and exit criteria are maintained in `docs/ONLINE_PROTOTYPE_PLAN.md`.


## Phase 5 — Figma implementation

Only after the functional structure is stable:

- reproduce Figma visual hierarchy;
- typography;
- spacing;
- colors;
- components;
- message presentation;
- onboarding visuals;
- navigation visuals;
- transitions;
- media presentation;
- empty/loading/error states;
- animations where they materially improve the experience.

The Figma design is the visual target, not the source of domain behavior.

## Phase 6 — UX pass

Use the real prototype and test the actual flow rather than only inspecting screenshots.

Focus on:

- onboarding friction;
- whether pairing feels obvious;
- whether Home immediately communicates what is waiting;
- whether sending feels delightful rather than like messaging;
- stale three-day behavior;
- history discoverability;
- Calendar usefulness;
- error recovery;
- offline/reconnect behavior;
- accessibility and readable typography;
- Android back behavior;
- loading transitions;
- media failure behavior.

This phase is where small interaction decisions should be refined based on actual use.

## Phase 7 — Initial release hardening

After UX is good:

- real-device regression testing;
- backend failure testing;
- migration testing;
- media cleanup testing;
- pairing expiry/retry testing;
- duplicate delivery testing;
- reconnect testing;
- app-kill/restart testing;
- CI/build/release checks;
- privacy/security review;
- logging/error reporting decisions;
- release build validation.

## Phase 8 — Post-MVP features

Only after the minimal product is proven:

- Android Home widget;
- notifications;
- drawing editor and drawing synchronization;
- statistics;
- richer relationship customization;
- other expressive features discovered during UX work.

The widget is especially important because it is intended to become an always-visible extension of Home, but it should not delay the first online prototype.

## Explicitly avoid for now

- building a large state-management architecture;
- adding features merely because they are easy;
- pixel-perfect UI before the functional loop is stable;
- treating the backend as the permanent source of message history;
- read receipts;
- reactions/replies;
- multiple relationships;
- account/login systems;
- replacing the simple v1 relationship-key design with a more complex asymmetric or ratcheting system before the first online prototype is proven;
- E2E key rotation/recovery beyond what is needed for the first prototype;
- statistics before the minimal product is proven;
- widget work before the online prototype unless needed for architecture validation.

## Development operating rule

For every development step:

1. implement the smallest coherent change;
2. inspect the resulting code;
3. run the appropriate validation available for that change;
4. perform a cleanup and edge-case pass;
5. report what actually passed or was not run;
6. state completion status;
7. propose the next concrete step.

Never claim local validation was performed if it was not actually run.
