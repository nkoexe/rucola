# Native SQLite Integration Test Plan

Rucola's repository implementation depends on `expo-sqlite`, so repository integration tests must execute inside a native Expo runtime. The Node test command remains reserved for platform-independent domain and application logic.

## Harness status

The development-only native harness is implemented at `src/data/nativeIntegration.ts` and exposed through the development Settings screen. It creates a uniquely named disposable SQLite database, initializes the real current schema, constructs the real `SQLiteRucolaRepository`, runs assertions, closes the database, and deletes the database afterward. The normal `rucola.db` is never used by the suite.

The harness code is present, but this document does **not** claim a current passing device/emulator run. A pass should only be recorded after the native development build actually executes the suite.

## Current schema

The native harness expects SQLite schema **version 6**.

A fresh test database verifies:

- foreign keys are enabled;
- the core relationship/message tables exist;
- `sync_state`, `sync_outbox`, and `sync_inbox` exist;
- the outbox includes the blocked state;
- the outbox includes nullable durable ciphertext and encryption-version columns.

## Current test coverage

The harness currently exercises:

### Database initialization

- fresh database creation at schema v6;
- concurrent initialization of the same database;
- initialization caching/recovery behavior.

### Message lifecycle

- setup creates the partner seed;
- first and subsequent ME sends work;
- replacing the ME active slot leaves prior messages in history;
- ME and PARTNER active slots are independent;
- message order indexes are monotonic;
- concurrent sends preserve every message and allocate unique/contiguous order indexes;
- concurrent repository instances can write safely against the same SQLite database.

### Persistence and integrity

- relationship and active-message state survive repository recreation;
- invalid foreign-key references are rejected;
- relationship reset removes the relationship and dependent messages.

### Media

- invalid/empty source URIs are rejected;
- selected media is copied into app-owned storage;
- video extensions follow MIME type;
- referenced media survives reconciliation;
- unreferenced owned media is cleaned up;
- owned media can be deleted;
- files outside the app-owned media directory are not deleted;
- broader media robustness edge cases are exercised by the dedicated media robustness suite.

### Synchronization state

The native harness runs the durable sync-state integration suite separately. That suite covers the real SQLite representation of sender sequence allocation, outbox retry/blocking semantics, durable encrypted payload persistence, inbound receipts/cursor state, stale/expired outbound reconciliation, and sync-state reset behavior.

### Migration

The migration integration suite covers the legacy schema fixtures and rollback/integrity behavior against the current schema target, including malformed legacy active-slot and numeric data.

## CI / execution policy

Do not add the native suite to `npm run test:domain`.

The native suite must remain separate because it requires a native Expo runtime and disposable SQLite databases. A development build can execute it manually through the development Settings screen.

A future CI job may automate it when a reliable emulator/device environment is available. CI documentation must report actual execution results rather than treating the presence of the harness as proof that native behavior passed.

## Maintenance rule

When the SQLite schema, repository behavior, media ownership rules, or sync-state semantics change:

1. update this plan;
2. update the relevant integration harness;
3. add or adjust regression coverage;
4. record only validation that was actually executed.
