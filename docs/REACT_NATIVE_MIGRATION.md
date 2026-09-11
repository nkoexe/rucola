# Rucola React Native Migration

## Goal

Replace the current Kotlin/Jetpack Compose UI prototype with an Expo + React Native + TypeScript application while preserving Rucola's product invariants and local/offline-first architecture.

The existing Kotlin implementation is a behavioral reference, not a code-conversion target.

## Phase 1 — Foundation

- Work only on `migration/react-native`.
- Scaffold Expo + React Native + TypeScript.
- Use an Expo development build / prebuild workflow rather than designing around Expo Go.
- Keep Android as the primary target.
- Keep native Android/iOS projects available for future home-screen widget work.
- Establish a minimal `src/` structure for app, screens, components, design tokens, domain, data, and state.
- Do not implement networking or the Cloudflare backend yet.
- Do not implement widgets yet.
- Do not preserve Compose solely for compatibility.

## Phase 2 — Local domain and persistence

- Port the domain model to TypeScript.
- Define repository interfaces before UI persistence access.
- Use Expo SQLite as the local source of truth.
- Persist relationships, messages, active-message slots, ordering, media references, and sync state.
- Keep message replacement transactional: one active message per participant and immutable history.
- Generate stable local message IDs.
- Keep the future server out of the local data layer.

## Phase 3 — First real UI

- Replace the foundation shell with the real onboarding flow.
- Current onboarding order: `who are they?` → `who are you?` → together-since → home.
- Do not add an avatar step or tutorial.
- Build the first home screen around the partner's active message.
- Add a local text composer that persists through the repository.
- Keep photo/video and drawing controls visible as placeholders until their native flows are implemented.
- Keep the visual language cute, personal, playful, slightly wonky and handmade.
- Do not introduce generic Material UI patterns just because React Native makes them convenient.

## Required product behavior to preserve

- Exactly one relationship with exactly two participants.
- One active message per participant.
- New messages archive the previous active message; history is immutable.
- History is permanent local data.
- The phone is the local source of truth; the future server is only a temporary mailbox.
- No replies, editing, deleting, reactions, or read receipts in MVP.
- Offline-first architecture: UI must consume local repositories/state, not the network directly.

## Initial migration target

The first React Native milestone should reproduce the current local prototype's behavior:

1. Pairing/setup entry.
2. Partner nickname.
3. Own name.
4. Together-since date or `shh... not yet`.
5. Local home screen with partner's current message.
6. Local text/emoji composer.
7. Placeholder photo/video and drawing flows.
8. Message replacement and local history.
9. Swipe from home into history.

The partner-avatar step is intentionally deferred from the current onboarding redesign.

## UI direction

Use the Figma file as visual reference:
`https://www.figma.com/design/UG8Q1GFnD9ajor0f62RRpK/rucola`

Rucola is cute, personal, playful, slightly wonky and handmade. Do not turn it into a generic Material 3 app.

Current onboarding copy direction:

- `who are they?`
- `who are you?`
- `when did you two become you two?`
- `shh... not yet`

Keep copy short, lowercase, personal, and slightly playful.

## Architecture direction

```text
React Native screens/components
        ↓
presentation state/hooks
        ↓
domain use cases + repository interfaces
        ↓
local persistence
        ↓
SQLite

future:
sync engine → Cloudflare mailbox API
```

Do not couple screens directly to SQLite or HTTP.

## Validation

The repository currently contains the Phase 2/3 implementation, but the GitHub integration cannot execute `npm install`, TypeScript, Expo prebuild, or an Android build. Run the following locally after pulling the branch:

```bash
npm install
npm run typecheck
npx expo prebuild
npm run android
```

Fix any dependency/version issues reported by Expo before continuing with native feature work.

## Next phase

Phase 4 should split the current prototype UI into proper screen/component files, add history, and introduce media/drawing composition. Native photo/video and drawing implementations should follow after the basic UI behavior is stable.
