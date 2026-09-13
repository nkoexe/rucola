# SQLite integration tests

`SQLiteRucolaRepository` uses `expo-sqlite`, so these tests cannot be executed by the plain Node test runner used by `npm run test:domain`.

The development-only native runner is implemented in `nativeIntegration.ts` and is loaded from the development Settings screen. It creates disposable databases and constructs the real `SQLiteRucolaRepository`; it never uses the user's normal `rucola.db`.

## Coverage

The native integration suite currently covers:

- fresh database creation and schema verification;
- setup and partner seed creation;
- concurrent setup idempotency;
- first send and active-message replacement;
- previous active message remaining immutable history;
- independent ME/PARTNER active slots;
- deterministic ordering across repeated and concurrent sends;
- repository re-instantiation and persistence;
- foreign-key and CHECK-constraint rejection;
- relationship deletion and owned-media cleanup;
- media reference ownership and validation;
- media orphan reconciliation;
- serialized media cleanup against concurrent writes;
- initialization failure/retry behavior;
- v0 and v1 legacy-schema migrations;
- malformed active-slot fixtures;
- invalid legacy `isActive` rejection;
- orphan active-message rejection;
- transactional rollback after migration data-transformation failure;
- incomplete legacy-schema rejection;
- newer unsupported-schema rejection;
- media robustness edge cases.

## Running the suite

The suite is exposed through the development-only native integration test screen. It uses disposable test databases and does not modify the normal app database.

The last validated result is **12/12 native integration groups passing** as part of the React Native migration merge validation.

`npm run test:domain` remains the Node-side domain/use-case suite and does not replace native SQLite integration coverage.
