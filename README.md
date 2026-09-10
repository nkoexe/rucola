# Rucola

Rucola is a small, offline-first Android mailbox for two people. The local Room database is the permanent history; synchronization is represented in the domain model but networking is intentionally not implemented yet.

## Build and run

Open the project in Android Studio, or run `gradle assembleDebug` with Android SDK platform 35 installed. Install `app/build/outputs/apk/debug/app-debug.apk` on a device or emulator.

Run unit tests with `gradle testDebugUnitTest`. The release variant is currently unsigned by design; signing can be supplied later through CI secrets without putting credentials in the repository.

The app starts with local setup, then supports a partner message view, text/emoji/photo-video/drawing message placeholders, and horizontal swipe navigation into immutable local history.

A private, offline-first mobile app for two people in a long-distance relationship.

> One thing waiting for you from the person you love.

Rucola is intentionally **not a chat app**. Each person has one active message; sending a new one moves the previous message into permanent local history.

## Status

Early development. The repository is being built incrementally through small, reviewable agent-driven tasks.

## Development

The project targets Android first. The concrete Android architecture/toolchain is chosen during the foundation phase; Kotlin + Jetpack Compose + local SQLite/Room is the default direction.

Read these before making substantial changes:

- [`AGENTS.md`](AGENTS.md) — instructions and non-negotiable product/engineering constraints for coding agents
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — product behavior and MVP scope
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — local-first architecture and future synchronization invariants

## Design

The visual direction is documented in the product/agent instructions and based on the Rucola Figma prototype. Rucola should feel pastel, cutesy, playful, handmade and slightly wonky — not like a generic Material app.

Figma: https://www.figma.com/design/UG8Q1GFnD9ajor0f62RRpK/rucola?node-id=0-1&p=f&t=uoSa92jCklllyBSR-0

## Git workflow

Work on branches and open pull requests against `main`. Do not develop directly on `main`.
