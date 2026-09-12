# Rucola — Development Roadmap

This roadmap translates the product direction into development phases. It is intentionally ordered so that the application can reach a rough real online prototype while functionality and backend work advance together.

## Current baseline

`main` contains the React Native/Expo migration, local SQLite repository, durable media handling, migration coverage, native integration coverage, documentation cleanup, and Android CI hardening.

Current foundation status:

- React Native / Expo foundation: complete
- local persistence: complete
- core message lifecycle: complete
- media picker/camera persistence: complete
- SQLite migrations: complete
- native integration suite: complete
- Android CI build pipeline: complete
- final navigation architecture: not complete
- final Home UX: not complete
- backend: not started
- real two-device pairing: not started
- online synchronization: not started
- final Figma implementation: not started

The next risk is application-layer structure and product completeness, not SQLite infrastructure.

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
- resolve the avatar/documentation discrepancy by either deferring avatars explicitly or implementing them later.

### Exit criteria

A fresh local installation can complete the whole experience without developer-only controls.

The message lifecycle works for bursts and restarts:

```text
A → B → C
```

without losing history or incorrectly showing an old active message.

## Phase 3 — Backend foundation in parallel

Backend work begins once Phase 1 has stabilized. It does **not** wait for pixel-perfect UI.

Goal: create the minimum real transport required for two anonymous installations to pair and exchange messages.

### Backend direction

Preferred stack remains:

- Cloudflare Workers — API/orchestration;
- D1 — relationship/metadata state;
- R2 — temporary media mailbox where required.

The backend is a temporary mailbox, not permanent history storage.

### Work

1. Define the network/domain contract without coupling screens directly to HTTP.
2. Define anonymous device identity lifecycle.
3. Define pairing state machine.
4. Implement five-emoji pairing UX and secure opaque invitation mechanism behind it.
5. Implement invitation expiry and single-use semantics.
6. Establish relationship between exactly two participants.
7. Implement message upload/send contract.
8. Implement recipient synchronization.
9. Preserve message order and bursts.
10. Acknowledge only after durable local persistence.
11. Handle offline/reconnect/retry behavior.
12. Preserve local history if the backend is unavailable.
13. Keep synchronization state separate from read/seen state.
14. Establish media upload/download lifecycle separately from local media persistence.

### Critical synchronization example

```text
Sender:
  A
  B
  C

Recipient offline

Server:
  A
  B
  C

Recipient reconnects:
  persist A
  persist B
  persist C

Local:
  A = history
  B = history
  C = active

Only then acknowledge delivery.
```

The server must not simply retain the newest active message and discard A/B.

## Phase 4 — First usable online prototype

This is the major halfway milestone.

### Definition

Two real people can use two real Android devices and:

- install the app;
- complete anonymous setup;
- pair using five emojis;
- exchange real messages over the Internet;
- send multiple messages while the other person is offline;
- reconnect and recover the complete ordered history;
- see the correct active message;
- continue using the app after restart.

### Prototype quality

The UI may still be rough.

The prototype is successful if the central relationship loop works reliably.

This milestone should be treated as a real product checkpoint, not just a technical demo.

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
