# Rucola — Development Roadmap

This roadmap translates the product direction into development phases. It is intentionally ordered so that the application can reach a rough real online prototype while functionality and backend work advance together.

## Current baseline

`main` contains the React Native/Expo migration, local SQLite repository, durable media handling, schema migrations through v5, native integration coverage, the typed cloud client foundation, durable local sync state/outbox/inbox, and Android release CI hardening.

Current foundation status:

- React Native / Expo foundation: complete
- local persistence: complete
- core message lifecycle: complete
- media picker/camera persistence: complete
- SQLite migrations: complete through schema v5
- native integration suite: implemented; the repository's latest recorded historical result is 12/12 groups, but current-tree execution is not claimed here
- Android CI build/release pipeline: implemented and hardened
- application navigation architecture: **not complete; Expo Router migration remains planned**
- final Home UX: not complete
- three-day stale Home behavior: not implemented
- cloud client transport foundation: **merged into `main`**
- durable local sync state/outbox/inbox: **implemented and tested**
- SyncEngine: **implemented and tested, but not wired into app lifecycle**
- credential persistence / SecureStore: not implemented
- user-facing pairing flow: not implemented
- real two-device online prototype: not complete
- cloud backend: **substantially implemented on `cloud/research`; final directional mailbox fix is open as PR #15**
- final Figma implementation: not started

The mobile and cloud workstreams are intentionally progressing in parallel. The cloud backend is no longer merely a design exercise, and the mobile client now has a transport/sync foundation. The remaining work is integration and production hardening, not a greenfield cloud implementation.

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

**Status: in progress / next mobile structure step.**

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
- resolve the avatar/documentation discrepancy by either deferring avatars explicitly or implementing them later.

The local repository and media functionality are largely implemented. The remaining Phase 2 work is primarily application lifecycle/navigation, stale-state behavior, and UX completion rather than basic persistence.

**Status: partially complete; do not treat Phase 2 as finished until the local product can run without developer-only controls and the three-day behavior exists.**

## Phase 3 — Backend and cloud client foundation in parallel

Backend work proceeds in parallel with the local/mobile phases. It does **not** wait for pixel-perfect UI.

Goal: create the minimum real transport required for two anonymous installations to pair and exchange messages reliably.

### Backend direction

Production stack:

- Cloudflare Workers — API/orchestration;
- D1 — relationship/metadata state and temporary mailbox;
- R2 — temporary media mailbox/storage.

The backend is a temporary mailbox, not permanent history storage. Local SQLite remains the durable source of truth.

### Cloud implementation status

The `cloud/research` workstream has implemented and tested substantially more than the original roadmap described. The current Worker contains:

- device-bound authentication;
- two-person relationship state and pairing bootstrap/create/accept;
- secure invitation handling and confirmation-attempt hardening;
- idempotent sync push with durable message receipts;
- sender/device/sequence invariants;
- pull and ACK endpoints;
- directional mailbox hardening in open PR #15;
- media reservation/upload/completion lifecycle;
- D1 invariants for message/media acceptance;
- cleanup/expiry logic;
- extensive Worker/Vitest coverage.

The cloud branch is still separate from `main`. Do not describe the backend as production-ready merely because the test suite is green: R2/deployment configuration, operational hardening, and the final protocol review remain part of the workstream.

### Mobile cloud foundation

Merged into `main` in PR #14:

- typed cloud protocol contracts;
- `CloudClient` transport with authentication and timeouts;
- pairing bootstrap/create/accept transport;
- durable sync push/pull/ACK transport;
- media reservation/upload/completion transport;
- typed server errors and response validation;
- SQLite sync state/outbox/inbox;
- atomic inbound persistence + cursor commit;
- ordered outgoing sync and inbound pull/commit/ACK in `SyncEngine`;
- concurrent sync-run coalescing;
- retry/backoff and permanently blocked outbox handling;
- device replacement and cursor recovery semantics;
- focused client/sync tests.

Not yet integrated:

- SecureStore credential persistence;
- app lifecycle/background scheduling;
- UI pairing flow;
- real encryption codec;
- end-to-end media synchronization;
- a production cloud base URL/configuration in the app.

### Remaining cloud work

1. Merge/finish the directional mailbox ownership hardening represented by PR #15.
2. Reconcile cloud docs and implementation around current ACK/receipt semantics.
3. Finish production operational hardening: rate limits, observability, migration/deployment safety, cleanup/recovery, and bounded resource usage.
4. Decide and implement the remaining product-level retention/poison-message/relationship-end policies where still open.
5. Wire the mobile cloud client into pairing and application lifecycle.
6. Persist device credentials securely.
7. Implement the real encryption layer after transport semantics are stable.
8. Integrate media synchronization end-to-end.

## Phase 4 — First usable online prototype

This is the major halfway milestone.

### Definition

Two real people can use two real Android devices and:

- install the app;
- complete anonymous setup;
- pair using the intended five-emoji flow;
- exchange real text/emoji messages over the Internet;
- send multiple messages while the other person is offline;
- reconnect and recover the complete ordered history;
- see the correct active message;
- continue using the app after restart.

Photo/video synchronization may remain a separate follow-up if the text/emoji online loop is deliberately used as the first prototype boundary, but the final initial release still requires media to work end-to-end.

### Prototype quality

The UI may still be rough.

The prototype is successful if the central relationship loop works reliably.

**Status: not reached.**

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

**Status: not started.**

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

**Status: not started.**

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

**Status: not started.**

## Phase 8 — Post-MVP features

Only after the minimal product is proven:

- Android Home widget;
- notifications;
- drawing editor;
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
- premature E2E implementation before the transport contract is stable;
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
