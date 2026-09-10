# Rucola — Product Specification

## 1. Concept

Rucola is a private mobile app for exactly two people in a long-distance relationship.

It is **not a chat app**.

The core idea is:

> **One thing waiting for you from the person you love.**

Each person can have exactly one active message. Sending a new message moves that person's previous active message into permanent local history.

## 2. Core experience

The main screen is about **receiving**. The partner's current message is the primary content. The user's own current message is not the focus, although it appears in history.

History is primarily reached by swiping from the home screen. There is also a fullscreen calendar overview showing which days contain messages and allowing navigation into that day's history.

The app should feel like a tiny private mailbox made for a couple: cute, personal, playful, slightly wonky and handmade.

## 3. Message model

Four user-facing message types exist:

- **Text** — text is required.
- **Emoji** — the emoji itself is the message.
- **Photo/video** — optional text; media-only messages are valid.
- **Drawing** — optional text; drawing-only messages are valid.

Video is first-class.

Messages are immutable in the MVP. There are no replies, threads, editing, deleting, or reactions.

Message limits should be generous. The UI should show character counts or warnings near limits / when a user goes overboard, rather than making the experience feel restrictive.

## 4. Message lifecycle

At most one message from each participant is active.

Example:

- A sends message A.
- A later sends B → A moves to history, B becomes active.
- A later sends C → B moves to history, C becomes active.

If a recipient was offline and later receives A, B, and C, all three must be preserved locally in order. C becomes the current active message and A/B become history.

There is no MVP read receipt. The app may know that messages were synchronized/delivered, but must not equate that with the user having seen them.

The UI may communicate that there are things/stuff waiting in history, but technical state must not be called `read`/`unread` unless actual read semantics are introduced later.

## 5. Relationship model

Exactly two people belong to one relationship.

There are no public profiles or social features.

### Anonymous identity

Fresh installation creates an anonymous device account/identity. There is no normal account registration UX.

### Pairing

Pairing will use:

- a shareable deep link
- a cute human-facing pairing code
- a separate secure invitation token with real entropy

Preferred human-facing code style: a short sequence of emoji from a controlled set, e.g. hearts/kisses. Words such as `luvya` or `l0v3` were considered, but emoji sequences are preferred.

The human-facing code must not be the security credential.

Invitations should expire after a limited time (target: 24 hours) and become invalid immediately after successful pairing.

### Names and avatars

During setup, each person chooses:

- what to call their partner
- which avatar represents their partner

These choices are independent. The two users do not need to choose the same canonical name.

Partner avatars can eventually be predefined cute avatars or a selected/taken photo of the partner.

### Together-since

Setup can ask for the date the relationship began, using a screen concept like:

`X and Y have been together since...`

Provide a cute `shh.. not yet` option. If skipped, the `Together for` feature remains hidden/unconfigured until later.

### Meeting countdown

There is a countdown feature (`X days until we meet`), but the next-meeting date is **not** part of initial onboarding. It can be configured later.

Either partner can change the next-meeting date and relevant relationship settings. The change should synchronize to both devices.

## 6. Home screen

The partner's active message is the main focus.

The user's own active message is secondary/not the main content.

The home experience should be visually expressive rather than a conventional feed or messaging timeline.

## 7. History

History is permanent local data.

It contains both participants' messages.

Primary navigation is a swipe gesture from home into history. A fullscreen calendar overview is also available.

Calendar behavior:
- show days containing messages
- allow navigation to a selected day
- show the messages from that day

History remains on the device even after unpairing.

## 8. Statistics

Statistics are a relationship feature, not an engagement-maximization mechanism.

Potential statistics include:

- messages exchanged
- active days
- current streak / longest streak
- message-type counts
- most-used emoji
- longest message
- number of drawings
- number of photos/videos

Streaks are planned, but their exact definition is still TBD.

## 9. Notifications

Notifications are important but should feel affectionate rather than spammy.

Desired tone:

`💌 Emma left something for you`

Notifications may vary by message type (photo, drawing, etc.). They should primarily prompt synchronization; message content need not be in the push payload.

## 10. Widgets

Widgets are a first-class feature.

They show the partner's current message and read local cached state rather than making network requests directly.

Multiple sizes can be added later. Exact widget design is not yet fixed.

## 11. Offline-first behavior

The phone is the permanent data store.

The server is a minimal temporary mailbox. It is not a backup and is not the archive/source of truth.

Everything already synchronized to the recipient is local-only on devices.

Media follows the same lifecycle as messages.

## 12. Synchronization model

The eventual server must queue unsynchronized messages in order.

A sender can send multiple messages while the recipient is offline. The recipient eventually receives every message, even if only the newest one is active by the time synchronization completes.

The server must only delete a message after the recipient has durably persisted it locally and sent a reliable acknowledgement.

The same rule applies to media objects.

Push/background execution should be designed for prompt synchronization but must respect platform limitations; do not promise guaranteed immediate background execution.

## 13. Unpairing

If a relationship is unpaired/ended:

- local history remains
- the app becomes read-only
- export and deletion are future features

Device recovery, re-pairing after deletion, and backup/export are future work.

## 14. MVP

The first milestone is an offline/local prototype that proves the UX and local architecture.

It should include:

- fresh-install setup
- partner nickname
- placeholder partner avatar
- optional together-since date with `shh.. not yet`
- partner current-message home screen
- local message creation
- text
- emoji
- placeholder photo/video flow
- placeholder drawing flow
- immutable local history
- replacing the user's active message
- swipe from home into history
- both participants' local history
- tests for the important repository/domain behavior
- CI that builds, tests, and produces development/release build outputs

The prototype may use seeded/fake local partner data, but it must go through real local repositories/use cases.

## 15. Explicitly out of MVP

- replies
- editing
- deleting
- reactions
- read receipts / read tracking
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

## 16. Future direction

Potential later milestones:

- Cloudflare Workers backend
- D1 metadata/state
- R2 temporary media mailbox
- secure pairing/deep links
- push notifications
- background synchronization
- real photo/video and drawing support
- widgets
- calendar/statistics/streaks
- E2E encryption using an established protocol/library
- encrypted backup/export
- device replacement/recovery
- reactions
- reliable read semantics if technically feasible
- distance
- richer widgets/media
- iOS support
