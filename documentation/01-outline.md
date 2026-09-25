# Technical Design Document — v0.1

## 1. Overview

### Working title

RUCOLA

### Purpose

A private mobile app for couples in long-distance relationships.

The app provides a simple asynchronous way for two people to leave small, personal messages for one another.

The central concept is:

> **One thing waiting for you from the person you love.**

Each person has exactly one active message. When they leave something new, their previous message becomes part of the permanent local history.

The app is deliberately **not a chat application**.

---

# 2. Product philosophy

The application should feel like a **cute private mailbox shared by two people**, rather than a conventional messaging or social-media product.

### Principles

* 💌 **One thing at a time**
* 🥰 **Cute and personal**
* 🏠 **Private to the couple**
* 📖 **Messages become memories**
* 📴 **Offline-first**
* 🪴 **Simple infrastructure**
* 🔒 **Privacy-first**
* 🫶 **Designed around receiving and leaving things**
* 🚫 **No engagement-maximizing mechanics**

The app should never feel like it is trying to compete with WhatsApp, Instagram, Snapchat, etc.

---

# 3. Target platform

### Primary

**Android**

### Potential secondary

**iOS**, if a multiplatform implementation provides sufficient benefit without compromising the Android experience.

Kotlin Multiplatform / Compose Multiplatform is a candidate.

**TBD:** final platform/framework decision.

The application is mobile-only.

No web or desktop client is planned.

---

# 4. Relationship model

The application supports exactly **one relationship per account/device**.

A relationship always contains exactly two people.

```text
Relationship
├── Person A
└── Person B
```

There are:

* no groups
* no friends
* no followers
* no multiple relationships
* no public profiles

The application is fundamentally a private two-person space.

---

# 5. Anonymous identity

There is no conventional registration in the MVP.

A fresh installation creates an **anonymous device account**.

```text
Installation
    │
    └── Anonymous identity
             │
             └── Relationship
                    ├── Person A
                    └── Person B
```

The exact identity/authentication mechanism is TBD.

### Important consequence

The device identity is not necessarily recoverable if the device is lost.

Backup/recovery will be addressed by a future export/backup system.

For MVP:

> **Local history is not a backup.**

---

# 6. Pairing

Two users connect using an invitation.

Supported mechanisms:

* pairing code
* deep link

### Pairing code

The code should deliberately feel cute rather than like a technical authentication token.

Possible format:

```text
💋 ❤️ 💕
```

using a small controlled vocabulary of romantic emojis.

Alternatively, cute generated words/codes could be considered.

The exact format and entropy/security model are **TBD**.

The human-facing code may be separate from the actual secure invitation token.

### Deep link

A generated invitation can be shared through normal phone sharing.

Opening the link launches the app and begins the pairing process.

### Invitation lifecycle

* invitation expires after a limited period
* invitation becomes invalid immediately after successful pairing
* an invitation cannot be reused

---

# 7. Initial setup

After pairing, the users configure their relationship together.

The setup is intentionally personal rather than account-like.

### Step 1 — Partner name

> **How should we call them?**

The user chooses the name/nickname they want to use for their partner.

This name is shown on the home screen.

The two users can therefore choose different names for each other.

Example:

```text
Nico → Emma
Emma → amore
```

### Step 2 — Partner name for you

The other person chooses what to call the user.

### Step 3 — Together date

Something along the lines of:

> **Nico & Emma have been together since...**

Select a date.

Alternative:

> **shh... not yet**

If skipped, the "Together for" feature remains hidden/unconfigured.

### Step 4 — Partner avatar

Each person chooses their partner's avatar.

Options:

* predefined cute avatars
* photograph taken with the camera
* existing photograph

The chosen avatar is primarily local relationship data.

---

# 8. Main screen

The main screen is the heart of the application.

It is focused almost entirely on **receiving**.

The user sees their partner's current active message.

Conceptually:

```text
             ♡ Emma

       ┌─────────────────┐
       │                 │
       │   good luck     │
       │     today!      │
       │                 │
       │       ♡         │
       └─────────────────┘

             18:42

        Together for
       1 year, 4 months

      12 days until we meet

           [ + ]

       ← swipe history
```

Exact visual design is TBD.

### Important

The user's own active message is **not the focus of the home screen**.

The philosophy is:

> **Open the app → see what they left for you.**

---

# 9. Visual direction

The application should have a distinctly:

* cute
* romantic
* playful
* slightly wonky
* handmade
* imperfect

visual language.

Avoid:

* corporate SaaS aesthetics
* sterile minimalism
* generic Material Design appearance
* social-media aesthetics
* excessive dashboards

Potential visual vocabulary:

* hand-drawn elements
* doodles
* hearts
* playful typography
* imperfect borders
* soft shapes
* charming animations
* small surprises/interactions

The exact design system will be developed separately.

---

# 10. Messages

Each person may have exactly **one active message**.

A message has one of four types:

### Text

```text
good morning ❤️
```

### Emoji

```text
🥺
```

### Photo / video

```text
[ PHOTO ]

optional text
"look what I saw today"
```

### Drawing

```text
[ DRAWING ]

optional text
"made this for you"
```

---

## Message composition rules

### Text

Text is required.

### Emoji

Emoji is the message itself.

### Photo/video

Text is optional.

A photo/video with no text is valid and encouraged.

### Drawing

Text is optional.

A drawing with no text is valid and encouraged.

The goal is to make **small, effortless messages** feel completely legitimate.

---

# 11. Message lifecycle

Messages are immutable.

There is:

* no editing
* no deletion
* no replying
* no reactions

When a person sends a new message:

```text
Previous active message
          ↓
       HISTORY

New message
          ↓
        ACTIVE
```

Example:

```text
Active:
"I miss you ❤️"

↓ send new message

History:
"I miss you ❤️"

Active:
"Look what I made!"
+ drawing
```

This creates an **append-only message history**.

---

# 12. Unseen messages

The application does **not currently implement read receipts or read state**.

However, if a person sends multiple messages while their partner is offline:

```text
A
B
C
```

the recipient receives all three during synchronization.

Their local state becomes:

```text
ACTIVE
C

HISTORY
B
A
```

The UI can communicate that there are older messages from the period the user was away.

Potential concept:

> **Things you haven't seen**

with an arrow into history.

This is intentionally **not a read receipt system**.

We do not claim the user did or did not actually see a message.

---

# 13. History

History is permanent on the device.

Primary access:

> **Swipe from the home screen**

This makes browsing old messages part of the main experience rather than a separate messaging interface.

History contains messages from **both people**.

Example:

```text
TODAY

Emma
"miss you ❤️"

You
"good luck!"

YESTERDAY

Emma
📷
"look at this"

You
✏️
```

---

# 14. Calendar history

History also has a dedicated fullscreen calendar view.

Example:

```text
       September 2026

 Mo Tu We Th Fr Sa Su
     1  2  3  4  5  6
  7  8  9 10 11 12 13
 14 15 16 17 18 19 20
 21 22 23 24 25 26 27
 28 29 30

      ♡ = something
```

Days containing messages can be visually marked.

Selecting a day opens the messages associated with that day.

This provides a quick overview of the relationship's history over months/years.

---

# 15. Relationship information

## Together for

If configured:

```text
Together for

1 year
4 months
12 days
```

Calculated locally from the relationship start date.

## Next meeting

A separate configurable date.

Example:

```text
12 days
until we meet ♡
```

Either partner can modify the date.

Changes synchronize to both devices.

Potential future behavior:

```text
Today ♡
```

when the date arrives.

---

# 16. Statistics

Statistics are about the relationship rather than engagement.

Potential statistics:

### Relationship

* together duration
* messages exchanged
* active days
* current streak
* longest streak

### Message types

* text messages
* emoji messages
* photos
* videos
* drawings

### Fun statistics

* most-used emoji
* longest message
* number of drawings
* number of photos
* most active days
* etc.

Exact statistics are TBD.

Statistics should remain secondary to the main experience.

---

# 17. Streaks

A connection streak is planned.

Example:

```text
♡ 37 day streak
```

The exact definition is TBD.

The system should avoid making the relationship feel like a gamified obligation.

---

# 18. Notifications

Notifications are important because the app's purpose is receiving.

A new message should trigger an immediate push notification where the platform permits it.

Example:

> 💌 Emma left something for you.

Other variants:

> ♡ Something from Emma is waiting for you.

> 📷 Emma left you a photo.

> ✏️ Emma drew something for you.

The notification does not need to contain the actual message content.

Tapping it opens the partner's current message.

---

# 19. Widgets

The home-screen widget is a first-class feature.

The widget displays the partner's current message.

Conceptually:

```text
┌───────────────────────┐
│ ♡ Emma                │
│                       │
│ "miss you so much"    │
│                       │
│ 18:42                 │
└───────────────────────┘
```

Possible widget sizes:

* small
* medium
* large

Media messages may display a suitable preview.

The widget should read from local application state rather than directly depend on the network.

---

# 20. Offline-first architecture

The application must work normally without an internet connection.

Offline functionality includes:

* viewing the current message
* viewing history
* viewing statistics
* viewing relationship information
* creating messages
* composing media/drawings

Messages created offline enter a local pending-sync state.

```text
Create message
      ↓
Local database
      ↓
Pending sync
      ↓
Internet available
      ↓
Server mailbox
      ↓
Partner
```

---

# 21. Synchronization

The server is a **mailbox**, not an archive.

This is a fundamental architectural principle.

### Server

Temporarily stores:

* messages waiting to be delivered
* required message metadata
* media waiting to be delivered
* relationship synchronization state

### Devices

Permanently store:

* complete message history
* media
* relationship information
* partner nickname
* partner avatar
* local application state

---

# 22. Mailbox lifecycle

Example:

Nico sends A:

```text
Nico
 ↓
Server mailbox
 ↓
Emma
```

If Emma is offline, A remains on the server.

If Nico then sends B and C:

```text
Mailbox:

A
B
C
```

When Emma reconnects:

```text
Emma downloads:
A
B
C
```

Her local database stores:

```text
History:
A
B

Active:
C
```

Once Emma has **successfully persisted** all three locally, she acknowledges them.

Only then can the server delete them.

The server therefore never deletes a message simply because it attempted delivery.

---

# 23. Media mailbox

Photos and videos follow the same model.

```text
Phone A
   │
   ├── message metadata
   └── media
          ↓
       mailbox
          ↓
       Phone B
          ↓
     local storage
```

After successful synchronization, the server may delete the media.

The server is therefore **temporary transport/storage**, not the couple's permanent photo/video archive.

---

# 24. Read state

No read state in MVP.

We deliberately do not track:

* delivered
* opened
* read
* widget viewed

A widget being rendered does **not** reliably mean the user consciously saw it, so it should not be used as a read receipt.

This may be reconsidered in a future version, potentially alongside reactions or other interaction features.

---

# 25. Privacy

Privacy is a core product principle.

The long-term goal is:

> **The couple owns their history; the server doesn't.**

MVP:

* local persistent history
* encrypted network communication
* server mailbox model
* minimal server-side retention
* no public content
* no social features
* no advertising

Future milestone:

* end-to-end encryption

E2E encryption should be implemented using an established cryptographic protocol/library rather than custom cryptography.

---

# 26. Unpairing

If a relationship ends or a user unpairs:

* relationship becomes read-only
* existing local history remains
* existing local media remains
* no new messages can be sent
* synchronization stops

The user can eventually:

```text
Export data
     ↓
Delete all data
```

Export functionality is **future work**.

The user cannot immediately create another relationship within the current relationship state.

Whether/requrement for re-pairing after complete deletion is TBD.

---

# 27. Device replacement

Not implemented in MVP.

The architecture should nevertheless allow a future:

> **Replace device**

mechanism.

Potential future solution:

* encrypted backup
* device transfer
* recovery key
* or another secure recovery mechanism

This is intentionally deferred.

---

# 28. Server architecture

The target is a **minimal serverless backend**.

Cloudflare is currently the leading candidate.

Potential architecture:

```text
                    Cloudflare
                 ┌──────────────┐
                 │    Worker    │
                 │              │
                 │ API / Auth   │
                 │ Pairing      │
                 │ Sync         │
                 └──────┬───────┘
                        │
              ┌─────────┴─────────┐
              ↓                   ↓
             D1                  R2
          metadata             media
```

Potential components:

### Cloudflare Workers

API and synchronization logic.

### D1

Small relational metadata:

* anonymous identities
* relationships
* pairing invitations
* mailbox metadata
* synchronization state

### R2

Temporary media mailbox:

* images
* videos
* potentially drawings if stored as files

The exact technology selection remains **TBD** until the sync protocol and media requirements are finalized.

---

# 29. Local application architecture

The phone should be considered the primary data store.

Potential model:

```text
                Application
                     │
          ┌──────────┴──────────┐
          │                     │
      Local DB             Local files
          │                     │
      metadata             images/video
      messages             drawings
      settings
          │
     ┌────┴────┐
     ↓         ↓
    App      Widget
```

A local SQLite-based database is a likely choice.

For multiplatform, the database layer should ideally be shared.

---

# 30. MVP scope

### Must have

**Relationship**

* anonymous device identity
* pairing
* invitation code
* deep link
* partner nickname
* partner avatar
* together-since date
* optional meeting date

**Messages**

* text
* emoji
* photo
* video
* drawing
* optional text on media/drawings
* immutable messages
* replacement
* history

**History**

* swipe from home
* chronological history
* both participants
* calendar overview

**Synchronization**

* offline-first
* immediate synchronization when online
* mailbox architecture
* media synchronization
* reliable acknowledgements

**Notifications**

* new message push

**Widget**

* partner's current message

**Stats**

* basic statistics
* streaks

---

# 31. Explicitly out of MVP

* ❌ replies
* ❌ editing
* ❌ deleting messages
* ❌ reactions
* ❌ read receipts
* ❌ location/distance
* ❌ multiple relationships
* ❌ public profiles
* ❌ social features
* ❌ ads
* ❌ E2E encryption
* ❌ device recovery
* ❌ export/backup
* ❌ web app
* ❌ desktop app

---

# 32. Future ideas

These are intentionally not commitments:

* E2E encryption
* encrypted backup/export
* device replacement
* reactions
* reliable read state if technically possible
* distance between partners
* more relationship statistics
* richer calendar visualization
* additional media types
* more drawing/pixel-art features
* richer widget interactions
* iOS support
* additional cute customization

---

# 33. Core technical invariants

These are worth keeping visible throughout development.

```text
ONE RELATIONSHIP
       │
       ├── exactly 2 people
       │
       ├── one active message per person
       │
       └── immutable history


SERVER
       │
       └── mailbox, NOT archive


PHONE
       │
       └── permanent history


HOME
       │
       └── partner's message


HISTORY
       │
       └── everything


NO
       ├── replies
       ├── edits
       ├── deletes
       ├── reactions
       └── read receipts
```
