# Native SQLite Integration Test Plan

Rucola's repository implementation depends on `expo-sqlite`, so repository integration tests must execute inside a native Expo runtime. The existing Node test command remains reserved for platform-independent domain tests.

## Harness status

The development-only native harness is implemented at `src/data/nativeIntegration.ts` and exposed through the development Settings screen. It creates a uniquely named disposable SQLite database, initializes the real schema, constructs the real `SQLiteRucolaRepository`, runs assertions, closes the database, and deletes it afterward. The normal `rucola.db` is never used by the suite.

The harness has not been executed in this environment, so its tests must not be described as passing until they are run in a native development build.

## Current test groups

Implemented:

1. Fresh database
   - initialize creates schema v2;
   - foreign keys are enabled;
   - core tables are created.
2. Message lifecycle
   - setup creates the partner seed;
   - first and second ME sends work;
   - second ME send replaces the active slot;
   - previous ME message remains history;
   - ME and PARTNER slots are independent;
   - ordering increases monotonically.
3. Persistence
   - relationship state survives repository recreation;
   - active message state survives repository recreation.
4. Integrity
   - an invalid active-slot foreign key is rejected.
5. Reset
   - relationship deletion removes relationship and messages.

Still to implement:

6. Setup recovery
   - partner seed is created exactly once;
   - missing partner active slot is recovered from partner history.
7. Media
   - media references persist;
   - relationship deletion removes database rows and invokes owned-media cleanup;
   - failed/missing media deletion does not prevent database reset.
8. Migration
   - valid v0/v1 fixtures migrate to v2;
   - malformed active-slot references fail safely;
   - malformed numeric fields fail safely;
   - failed migration rolls back instead of leaving a half-migrated schema.
9. Integrity edge cases
   - invalid participant/type/sync-state values are rejected;
   - active slots cannot point at another relationship or participant;
   - deleting a message referenced by an active slot is rejected.
10. Initialization recovery
   - a failed initialization does not poison the cached initialization promise;
   - retry can initialize the database successfully.
11. Ordering/concurrency
   - repeated sends never reuse an order index;
   - concurrent sends are checked for duplicate order allocation.

## CI

Do not add this suite to `npm run test:domain`. The native suite currently runs manually from a development build through Settings. Once the suite is complete and a reliable emulator/device workflow is available, add a separate CI job that builds/boots the native test environment and runs it.
