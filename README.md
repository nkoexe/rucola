# Rucola

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
