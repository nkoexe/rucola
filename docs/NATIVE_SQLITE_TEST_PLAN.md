# Native SQLite Integration Test Plan

Rucola's repository implementation depends on `expo-sqlite`, so repository integration tests must execute inside a native Expo runtime. The Node test commands remain reserved for platform-independent domain/cloud-client/sync-engine tests.

## Harness status

The development-only native harness is implemented at `src/data/nativeIntegration.ts` and exposed through the development Settings screen. It creates uniquely named disposable SQLite databases, initializes the real schema, constructs the real repository, runs assertions, closes the database, and deletes the test database afterward. The normal `rucola.db` is never used by the suite.

The harness currently verifies schema **v5**, not the old v2 baseline.

## Current test groups

Implemented:

1. Fresh database and schema v5 verification.
2. Concurrent database initialization.
3. Message lifecycle and active-slot replacement.
4. Concurrent message ordering.
5. Concurrent repository-instance ordering.
6. Persistence across repository instances.
7. Foreign-key integrity.
8. Relationship reset.
9. Media persistence, ownership, reconciliation and cleanup.
10. Media robustness edge cases.
11. Durable sync-state/outbox/inbox integration.
12. Legacy schema migrations and rollback fixtures.

The exact native result count is now produced by the development harness rather than represented as a fixed permanent pass count in this plan. Historical migration validation recorded 12/12 groups passing, but that historical result must not be treated as proof for later commits without rerunning the current tree.

## Coverage areas

The current harness covers, among other cases:

- fresh schema creation and verification;
- setup and partner seed creation;
- concurrent setup and sends;
- active-message replacement and immutable history;
- independent participant slots;
- repository re-instantiation/persistence;
- media ownership and cleanup;
- media orphan reconciliation;
- initialization failure/retry;
- schema migration and malformed legacy data;
- unsupported newer schemas;
- durable outbox state and blocked retry behavior;
- persisted pull cursor and inbound sync state.

## Running the suite

The suite is exposed through the development-only native integration test screen. It uses disposable test databases and does not modify the normal app database.

A native development build/device or emulator is required. Do not claim the native suite passed unless the harness was actually executed.

## CI

Do not add this suite to `npm run test:domain`. The native suite remains separate from Node tests because it exercises real Expo SQLite behavior. A dedicated native CI job can be added when a reliable emulator/device workflow is available.
