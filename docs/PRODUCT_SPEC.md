# Rucola — Product Specification

This document is the product source of truth for the initial Rucola direction. It describes what Rucola is supposed to feel like and which behavior is intentional. It should be updated when a product decision changes, rather than relying on scattered conversation history.

## 1. Product identity

Rucola is a private mobile app for exactly two people in a relationship. It is **not a conventional chat app**.

Core idea:

> One thing waiting for you from the person you love.

The product is deliberately minimal. The Home experience is the center of the app; History, Calendar, Settings, pairing, synchronization, notifications, and later features exist to support that experience.

The first release should not try to become a social network, a general-purpose messenger, or a feature-heavy relationship platform.

## 2. Platform and release strategy

- Android is the first and current target platform.
- React Native + Expo is the application stack.
- The local application should become a complete usable product before visual polish is finalized.
- Backend development should progress in parallel once the local application structure is stable.
- A deliberately rough but genuinely online two-person prototype is an explicit milestone, not something postponed until the final release.

## 3. Product milestones

### Milestone A — complete local product

The app can be installed and used as a complete local experience:

- onboarding and relationship setup;
- message creation;
- partner-message Home experience;
- message replacement/history semantics;
- text, emoji, photo/video;
- History;
- Calendar;
- Settings/reset;
- correct empty, waiting, stale, error, and restart states.

The UI does not need to perfectly match Figma yet.

### Milestone B — first usable online prototype

Two real people on two real Android devices can:

1. install Rucola;
2. anonymously establish identities;
3. pair using the five-emoji pairing flow;
4. exchange messages over the Internet;
5. survive normal offline/reconnect situations without losing message history;
6. observe the correct active/history result on both devices.

This is the **halfway / first real prototype milestone**.

It is intentionally allowed to look rough. The important requirement is that the central product loop works for two people.

### Milestone C — initial release quality

After the online prototype exists:

- the app follows the Figma design closely;
- all basic barebones functionality is implemented;
- navigation and interaction order are coherent;
- real-device UX testing has been performed;
- obvious friction has been removed;
- the Home experience feels intentional and reliable.

This is the current definition of **done** for the initial product.

## 4. First-run experience

The first-run experience should feel like an intentional introduction, not a settings form.

Target flow:

```text
Rucola logo / opening
        ↓
Pair with your person
        ↓
Partner name
        ↓
Your name
        ↓
Together since
        ↓
Home
```

The exact transitions and visual treatment are a later Figma/UX task, but the order and conceptual separation of these steps are important.

### Pairing

Pairing uses **five emojis. Period.**

The human-facing pairing interaction should never expose technical IDs, tokens, device IDs, or account concepts.

The security implementation behind the flow may use an opaque high-entropy invitation token, but that token is an implementation detail and must not replace the five-emoji user experience.

There are no normal user accounts or login screens in the initial product.

Each installation has an anonymous device identity. Pairing establishes the relationship between two anonymous identities.

## 5. The Home experience

Home is the central product experience and should always make the relationship state immediately understandable.

Once paired, the user should primarily see the latest message from the partner and have an obvious way to send something back.

The product should not visually resemble a traditional conversation thread. The active partner message is the thing waiting for the user.

### Active-message rule

Each participant has at most one active message.

For a user viewing their Home screen:

- the partner's latest message is the primary content;
- older partner messages remain in History;
- the user's sent messages remain in History once replaced;
- sending a new message replaces the sender's own active message and archives the previous one;
- immutable history is never lost by active-message replacement.

### Message lifecycle example

```text
Partner sends A
        ↓
Home shows A
        ↓
User sends B
        ↓
User's B becomes active for the user
        ↓
Partner sends C
        ↓
Home shows C
```

The local database and eventual synchronization model must preserve all messages, not just the newest active message.

## 6. Message types

Initial supported types:

- `TEXT`
- `EMOJI`
- `PHOTO_VIDEO`

`DRAWING` remains a planned type but is not part of the initial usable feature set until a real drawing editor exists.

Photo/video is real functionality: the user can select or capture media and Rucola stores an app-owned durable copy before persisting the message.

## 7. Sending interaction

The exact visual interaction is still open and should be decided before the Figma implementation. The product requirement is:

- Home stays simple;
- sending should be immediately accessible;
- text, emoji, and photo/video should be easy to choose;
- the user should not have to navigate through a conventional chat composer;
- sending should feel like leaving something for the other person.

A bottom sheet or similarly lightweight send affordance is a candidate, but is not yet a locked product decision.

## 8. Three-day stale-message behavior

The partner's latest message remains the central Home experience for up to three days.

After three days without a newer partner message, Home should communicate that the relationship is waiting for interaction rather than presenting an ordinary stale message forever.

Target behavior:

```text
Partner's message is recent
        ↓
Show message normally

No newer partner message for 3 days
        ↓
Show a gentle prompt such as:
"It's been a while since X sent you something..."
        ↓
Encourage the user to hit them up / send something
```

This is a product rule, not merely a visual decoration. The exact copy can change during UX work.

The old message remains available in History.

## 9. Offline behavior

Rucola is offline-first.

Local SQLite and app-owned media are authoritative for the user's local history. A backend outage must not make existing history disappear.

When synchronization exists, messages must survive bursts while the recipient is offline.

Example:

```text
A sends A
A sends B
A sends C

B is offline

Server temporarily holds A, B, C

B reconnects
B persists A, B, C in order

B local state:
  A = history
  B = history
  C = active
```

The backend must never collapse a burst to only the final active message because complete history matters.

## 10. Notifications

Notifications are complementary, not the central experience.

The Android Home/widget experience is the long-term always-visible surface. Notifications should support awareness and re-entry rather than become the main message interface.

Notifications should generally prompt synchronization rather than contain sensitive message content.

## 11. Android Home widget

The widget is intended to be an important extension of the Home experience: the same relationship state should be available without opening the app.

The widget should read local state rather than require a live network request merely to render the current partner message.

The widget should be designed as another presentation of the same underlying Home state, not as a separate product or separate message model.

Widget implementation is later than the first online prototype, but the application architecture should avoid making it impossible.

## 12. History

History is permanent local message history.

Initial purpose:

> See what we have sent each other before.

It should initially behave as a straightforward chronological message timeline. A more visual memories-oriented experience can be considered later.

History must include both participants' messages and retain messages that are no longer active.

No editing, deletion, replies, reactions, or read receipts are part of the initial product.

## 13. Calendar

Initial Calendar purpose:

> See what we sent each other on a particular day.

Calendar should group/filter the existing message history by local calendar day. Relationship events and richer calendar features are future scope.

## 14. Settings

Settings should remain minimal.

Initial responsibilities:

- relationship information;
- local data reset;
- basic app information;
- future placeholders for pairing/sync where useful.

Do not turn Settings into an account-management center because the product does not have normal accounts.

Clearing local data is a destructive local reset and is distinct from eventual unpairing.

## 15. Unpairing

Future unpairing should not automatically mean deleting history.

Target semantic:

```text
relationship ends
        ↓
local history remains
        ↓
app becomes read-only
```

Export/deletion is a separate future feature.

## 16. Security and privacy direction

Rucola is private by design.

- anonymous identities;
- no normal account registration;
- no public profiles;
- exactly two participants per relationship;
- pairing establishes one private relationship;
- future message transport should use end-to-end encryption;
- server storage is a temporary mailbox, not the permanent source of truth.

For the first online prototype, E2E v1 uses a random 256-bit relationship encryption key generated locally and transferred out-of-band during pairing; the Worker never receives the key. Message payloads use AES-256-GCM with authenticated context. This is the first prototype's concrete security design, not the final long-term key-management system. Future key rotation, recovery, and stronger device identity mechanisms remain separate hardening work.

## 17. Deliberately out of initial scope

Do not let these features pull the MVP away from the central experience:

- statistics;
- widgets before the core online prototype;
- notifications as a primary UX;
- drawing editor;
- reactions;
- replies;
- read receipts;
- message editing/deletion;
- multiple relationships;
- public/social features;
- normal account/login UX;
- large-scale state-management infrastructure;
- pixel-perfect Figma implementation before functionality is stable.

Statistics and richer relationship features can come after the minimal product is proven.

## 18. Product principles

1. **The Home screen is the product.**
2. **One active thing is better than a noisy feed.**
3. **History is permanent and meaningful.**
4. **The backend enables the relationship; it does not become the product.**
5. **Technical security details stay invisible to the user.**
6. **Offline behavior must never casually destroy history.**
7. **Minimal first; expressive features later.**
8. **Functionality before visual polish, but navigation and interaction order must be coherent from the start.**
9. **Build toward a real two-person online prototype early.**
10. **Do not add architecture merely because a larger app might someday need it.**
