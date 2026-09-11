# Native SQLite integration tests

`SQLiteRucolaRepository` uses `expo-sqlite`, so these tests cannot be executed by the plain Node test runner used by `npm run test:domain`.

The development-only runner is implemented in `nativeIntegration.ts` and is exposed from Settings in a native development build. It creates disposable databases and constructs the real `SQLiteRucolaRepository`; it never uses the user's normal `rucola.db`.

The current runner has not been executed in this environment. Do not report native integration coverage as passing until the suite has actually been run in a native development build.

Implemented scenarios:

- fresh database creation and schema verification;
- setup and partner seed creation;
- first send and active-message replacement;
- previous active message remaining history;
- independent ME/PARTNER active slots;
- deterministic ordering across repeated sends;
- repository re-instantiation persistence;
- foreign-key rejection;
- relationship deletion;
- v0 legacy-schema migration;
- v1 legacy-schema migration;
- malformed active-slot fixtures (missing message and participant mismatch);
- invalid legacy `isActive` rejection;
- orphan active-message rejection;
- transactional rollback after a migration fails during data transformation.

Still required:

- media reference and owned-media cleanup behavior;
- additional foreign-key/check-constraint cases;
- initialization failure and retry;
- concurrent/order-allocation behavior;
- native execution of the full suite.
