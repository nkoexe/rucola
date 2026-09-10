# Rucola — Agent Instructions

## Mission

Rucola is a private mobile app for exactly two people in a long-distance relationship. It is **not a chat app**. The core idea is: **one thing waiting for you from the person you love**.

Treat this repository as a real product codebase even though it is a personal project. Prefer simple, understandable solutions over enterprise ceremony.

## Before changing code

1. Read `docs/PRODUCT.md` and `docs/ARCHITECTURE.md`.
2. Inspect the existing code and build configuration before introducing dependencies or patterns.
3. Inspect the Figma design for visual direction when working on UI:
   `https://www.figma.com/design/UG8Q1GFnD9ajor0f62RRpK/rucola?node-id=0-1&p=f&t=uoSa92jCklllyBSR-0`
4. Preserve the product invariants below. If a requested implementation conflicts with them, stop and explain the conflict rather than silently changing the product model.

## Product invariants

- One relationship per account/device, exactly two participants.
- Each participant has exactly one active message.
- Sending a new message moves that participant's previous active message into immutable history.
- Messages are immutable: no editing or deleting in MVP.
- History contains both participants' messages and is permanent local data.
- The phone is the permanent data store; the server is only a temporary mailbox.
- The server must never become the archive/source of truth.
- The home screen focuses on the partner's current message.
- History is primarily reached by swiping from the home screen.
- No replies, threads, reactions, or read receipts in MVP.
- Do not implement a fake "read" state. Delivery/synchronization is different from the user having actually seen something.
- Offline-first is fundamental. UI should consume local repositories/state, not directly depend on the network.
- Future synchronization must be possible without rewriting the UI or local data model.

## MVP message types

1. Text — text required.
2. Emoji — the emoji itself is the message.
3. Photo/video — optional text; media-only is valid.
4. Drawing — optional text; drawing-only is valid.

Video is a first-class media type, not an afterthought.

## Current implementation phase

The first implementation milestone is a local/offline UI prototype. Networking is intentionally not required yet, but the architecture must already separate UI, domain, persistence, and future synchronization concerns.

Initial flow:

1. Fresh-install setup.
2. Choose partner nickname.
3. Choose placeholder partner avatar.
4. Optionally choose a together-since date; allow a cute `shh.. not yet` option.
5. Main screen showing the partner's local current message.
6. Create a local message.
7. Support text and emoji; provide sensible placeholder flows for photo/video and drawing until their real editors/pickers are implemented.
8. Sending a new own message archives the previous own active message.
9. Swipe from home into history.
10. Browse both participants' local message history.

Seeded/fake local data is acceptable for demonstrating the UI, but it must pass through the same repository/use-case layer that real data will use.

## Architecture guidance

- Android is the primary target.
- Use Kotlin.
- Prefer Jetpack Compose unless there is a strong technical reason not to.
- Choose a modern stable Android toolchain and a reasonable current minimum SDK.
- Kotlin Multiplatform is allowed only if there is a concrete benefit for the future iOS target. Do not add KMP just for theoretical portability.
- Use SQLite through a proper abstraction such as Room for local persistence.
- Keep the structure clean but proportionate to a small personal app.
- Separate UI, domain/model, persistence, and synchronization/network concerns.
- Introduce a synchronization abstraction/state model early, without implementing networking in the foundation phase.
- Do not model Cloudflare or a remote API as the source of truth.

Future backend direction (not required in the first phase): Cloudflare Workers + D1 for metadata/state + R2 for temporary media, unless implementation research identifies a strong technical reason to choose otherwise.

Future synchronization requirements:
- Sender may send A, then B, then C while recipient is offline.
- All three must eventually be deliverable in order.
- C becomes the current active message; A and B become history.
- A replaced active message must remain in the server mailbox until the recipient has durably persisted it locally.
- The server may delete a message/media object only after reliable recipient acknowledgement of durable local persistence.
- Server storage is transient and minimal.
- Push notifications should prompt synchronization when platform capabilities permit; notification payloads should not need to contain message content.
- Widgets read local state/cache, not the network.
- Background synchronization should update local state and then the widget.
- Do not claim platform background execution is guaranteed to be immediate.

Future security requirements:
- Network traffic encrypted in MVP.
- End-to-end encryption is a future milestone, not MVP.
- When E2E is implemented, use an established protocol/library; never invent cryptography.
- Pairing will use a cute human-facing code plus a separate secure invitation token. Invitations expire (target: 24h) and become invalid immediately after successful pairing.

## Pairing and relationship setup

There is no normal account-registration UX. A fresh install creates an anonymous device identity.

Pairing will eventually use a shareable deep link and a cute human-facing pairing code, preferably a short emoji sequence from a controlled set (e.g. hearts/kisses). Human-facing codes are not security tokens.

Each person independently chooses what to call the other person and which avatar represents the partner. Together-since is optional and can be configured later.

Unpairing behavior:
- Local history remains.
- The app becomes read-only.
- Export/deletion/re-pairing are future work.

## UX / visual direction

Rucola should feel like a tiny private mailbox made for a couple: cute, personal, playful, slightly wonky and handmade.

Use the Figma prototype as the source for general visual language. Current direction:
- pastel, cutesy palette
- very pale green background
- pastel green/yellow surfaces
- large playful rounded/organic shapes
- intentionally imperfect geometry and borders
- hand-drawn/pixel-art feeling
- playful typography
- cute animations where useful
- warm and personal rather than sterile/corporate
- do not turn the app into a generic Material 3 showcase

The owner will create the final pixel-art assets later. Do not fabricate a large asset library just to fill space.

Material components may be used where useful, but Rucola's own design tokens/components should control the visual identity.

## Important product features for later phases

- Permanent local history.
- Fullscreen calendar history overview; days containing messages are indicated and a day opens that day's messages.
- Relationship information: `Together for` and an `X days until we meet` countdown.
- Either partner can change the next-meeting date and relevant relationship settings; changes synchronize to both.
- Statistics such as exchanged messages, active days, streaks, message-type counts, most-used emoji, longest message, drawings/photos, etc. Avoid engagement-gaming.
- Streaks are planned; exact definition is TBD.
- Important, affectionate notifications such as `💌 Emma left something for you`, potentially varying by message type.
- Home-screen widgets showing the partner's current message; widget sizes/design can evolve.

Do not implement future features opportunistically unless the current task explicitly asks for them.

## Explicit MVP exclusions

Do NOT add:
- replies
- editing
- deleting
- reactions
- read receipts/read tracking
- distance/location
- multiple relationships
- public/social profiles
- ads
- E2E encryption
- device recovery
- export/backup
- web/desktop client
- next-meeting date during initial onboarding
- unnecessary advanced customization

## Testing and CI

Tests and CI are required. Formatting/linting are useful but not a priority.

At minimum, test domain/repository behavior for:
- creating a message
- replacing an active message
- moving the previous active message to history
- ordering
- persistence
- the one-active-message-per-participant invariant

Add Android UI/instrumentation tests for critical flows where practical.

GitHub Actions should:
- build the project
- run tests
- produce a development APK artifact
- exercise the production/release build path
- keep signing credentials out of the repository; production signing will be supplied through GitHub Secrets later

Avoid elaborate CI infrastructure for its own sake.

## Git workflow

- Work on a feature/chore branch; never implement directly on `main`.
- Open a pull request against `main`.
- Keep commits focused and understandable.
- Do not rewrite unrelated code.
- Do not commit secrets, signing material, local machine configuration, generated build output, or IDE state.
- PR descriptions should explain what changed, how it was tested, and any deliberate trade-offs.

## Definition of done

A task is not done merely because the code compiles locally.

Before opening a PR:
1. Build from a clean checkout.
2. Run the relevant tests.
3. Verify the app behavior described by the task.
4. Check that the implementation respects the product invariants.
5. Keep the diff focused.
6. Update minimal documentation if the behavior or setup changed.

If something cannot be verified, state that clearly in the PR instead of pretending it was tested.
