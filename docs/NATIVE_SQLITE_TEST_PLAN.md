# Native SQLite Integration Test Plan

Rucola's repository implementation depends on `expo-sqlite`, so repository integration tests must execute inside a native Expo runtime. The existing Node test command remains reserved for platform-independent domain tests.

## Required harness

Use a development build with a dedicated development-only integration-test entry point. The runner should create/use a disposable SQLite database, construct `SQLiteRucolaRepository` with the real `SQLiteDatabase`, execute assertions, and report pass/fail visibly. Tests must never touch the user's normal `rucola.db`.

## Test groups

1. Fresh database
   - initialize creates schema v2;
   - foreign keys are enabled;
   - integrity check is clean.
2. Setup lifecycle
   - setup persists across repository instances;
   - partner seed is created exactly once;
   - missing partner active slot is recovered from partner history.
3. Message lifecycle
   - first ME send creates active message;
   - second ME send replaces the active slot;
   - previous ME message remains immutable history;
   - ME and PARTNER slots are independent;
   - ordering remains deterministic.
4. Persistence
   - all relationship/message state survives repository recreation;
   - active state is derived only from the active-slot table.
5. Media
   - media references persist;
   - relationship deletion removes database rows and invokes owned-media cleanup;
   - failed/missing media deletion does not prevent database reset.
6. Migration
   - valid v0/v1 fixtures migrate to v2;
   - malformed active-slot references fail safely;
   - malformed numeric fields fail safely;
   - failed migration rolls back instead of leaving a half-migrated schema.
7. Integrity
   - invalid participant/type/sync-state values are rejected;
   - active slots cannot point at another relationship or participant;
   - deleting a message referenced by an active slot is rejected.
8. Initialization recovery
   - a failed initialization does not poison the cached initialization promise;
   - retry can initialize the database successfully.
9. Ordering/concurrency
   - repeated sends never reuse an order index;
   - concurrent sends are checked for duplicate order allocation.

## CI

Do not add this suite to `npm run test:domain`. Once a supported native runner is implemented, add a separate CI job that builds/boots the native test environment and runs this plan. Until then, report native integration coverage as pending rather than pretending Node tests cover SQLite.
