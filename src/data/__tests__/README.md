# Native SQLite integration tests

`SQLiteRucolaRepository` uses `expo-sqlite`, so these tests cannot be executed by the plain Node test runner used by `npm run test:domain`.

The integration suite must run inside a native Expo development build (or another supported native test environment) so the real SQLite module is loaded. Until that runner is wired into CI, keep repository tests separate from the Node-only domain suite and never label mock tests as SQLite integration coverage.

Required scenarios:

- fresh database creation and schema verification;
- setup persistence and repository re-instantiation;
- partner seed persistence/recovery;
- first send and active-message replacement;
- previous active message remaining immutable history;
- independent ME/PARTNER active slots;
- deterministic ordering across repeated sends;
- media reference persistence;
- relationship deletion and owned-media cleanup;
- v0/v1 migration fixtures;
- malformed migration rollback;
- foreign-key integrity;
- initialization failure and retry;
- concurrent/order-allocation behavior.
