import * as SQLite from 'expo-sqlite';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';
import { initializeDatabase } from './database';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

async function withRawTestDatabase<T>(test: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const databaseName = `rucola-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const db = await SQLite.openDatabaseAsync(databaseName);
  try {
    await db.execAsync('PRAGMA foreign_keys = ON;');
    return await test(db);
  } finally {
    await db.closeAsync();
    await SQLite.deleteDatabaseAsync(databaseName).catch(() => undefined);
  }
}

async function createLegacySchema(db: SQLite.SQLiteDatabase, version: 0 | 1): Promise<void> {
  await db.execAsync(`
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY NOT NULL,
      partnerNickname TEXT NOT NULL,
      ownName TEXT NOT NULL,
      partnerColor TEXT NOT NULL,
      togetherSince INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      orderIndex INTEGER NOT NULL,
      isActive INTEGER NOT NULL,
      mediaReference TEXT,
      syncState TEXT NOT NULL,
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE
    );
    CREATE TABLE active_message_slots (
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL,
      messageId TEXT NOT NULL,
      PRIMARY KEY (relationshipId, participant),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE
    );
    PRAGMA user_version = ${version};
  `);
}

async function insertValidLegacyFixture(
  db: SQLite.SQLiteDatabase,
  options: { createdAt?: number | string; activeState?: number } = {},
): Promise<void> {
  const { createdAt = 1000, activeState = 1 } = options;
  await db.runAsync(
    `INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince)
     VALUES ('the-one', 'Partner', 'Nico', '#8FC56A', 123456789)`,
  );
  await db.runAsync(
    `INSERT INTO messages
     (id, relationshipId, participant, type, body, createdAt, orderIndex, isActive, mediaReference, syncState)
     VALUES ('partner-message', 'the-one', 'PARTNER', 'TEXT', 'hello', ?, 0, ?, NULL, 'SYNCED')`,
    createdAt,
    activeState,
  );
  await db.runAsync(
    `INSERT INTO messages
     (id, relationshipId, participant, type, body, createdAt, orderIndex, isActive, mediaReference, syncState)
     VALUES ('old-message', 'the-one', 'ME', 'TEXT', 'old', 900, 1, 0, NULL, 'LOCAL_ONLY')`,
  );
  await db.runAsync(
    `INSERT INTO active_message_slots (relationshipId, participant, messageId)
     VALUES ('the-one', 'PARTNER', 'partner-message')`,
  );
}

async function assertLegacySchemaPreserved(db: SQLite.SQLiteDatabase, expectedVersion: 0 | 1): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  assertEqual(version?.user_version, expectedVersion, 'Failed migration must preserve the original schema version');

  const messageColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)');
  assert(messageColumns.some((column) => column.name === 'isActive'), 'Failed migration must preserve the legacy messages schema');

  const legacyTables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_legacy'",
  );
  assertEqual(legacyTables.length, 0, 'Failed migration must not leave temporary renamed tables behind');
}

async function createCurrentV3Schema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY NOT NULL,
      partnerNickname TEXT NOT NULL,
      ownName TEXT NOT NULL,
      partnerColor TEXT NOT NULL,
      togetherSince INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
      type TEXT NOT NULL CHECK (type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')),
      body TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      orderIndex INTEGER NOT NULL,
      mediaReference TEXT,
      syncState TEXT NOT NULL CHECK (syncState IN ('LOCAL_ONLY', 'PENDING', 'SYNCED', 'FAILED')),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE,
      UNIQUE (relationshipId, id),
      UNIQUE (relationshipId, participant, id)
    );
    CREATE INDEX messages_relationship_order ON messages (relationshipId, orderIndex DESC, createdAt DESC, id DESC);
    CREATE TABLE active_message_slots (
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
      messageId TEXT NOT NULL UNIQUE,
      PRIMARY KEY (relationshipId, participant),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE,
      FOREIGN KEY (relationshipId, participant, messageId) REFERENCES messages(relationshipId, participant, id) ON DELETE RESTRICT
    );
    CREATE TABLE sync_state (
      relationshipId TEXT PRIMARY KEY NOT NULL,
      deviceId TEXT,
      participant TEXT CHECK (participant IS NULL OR participant IN ('ME', 'PARTNER')),
      nextSenderSeq INTEGER NOT NULL CHECK (nextSenderSeq >= 1),
      pullCursor INTEGER NOT NULL CHECK (pullCursor >= 0),
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE
    );
    CREATE TABLE sync_outbox (
      relationshipId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      senderSeq INTEGER NOT NULL CHECK (senderSeq >= 1),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      lastError TEXT,
      nextAttemptAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (relationshipId, messageId),
      UNIQUE (relationshipId, senderSeq),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE,
      FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX sync_outbox_due ON sync_outbox (relationshipId, nextAttemptAt, senderSeq);
    PRAGMA user_version = 3;
  `);
}

async function createCurrentV2Schema(db: SQLite.SQLiteDatabase): Promise<void> {
  await createCurrentV3Schema(db);
  await db.execAsync('DROP INDEX sync_outbox_due; DROP TABLE sync_outbox; DROP TABLE sync_state; PRAGMA user_version = 2;');
}

async function createCurrentV4Schema(db: SQLite.SQLiteDatabase): Promise<void> {
  await createCurrentV3Schema(db);
  await db.execAsync(`
    CREATE TABLE sync_inbox (
      relationshipId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      serverSeq INTEGER NOT NULL CHECK (serverSeq >= 1),
      PRIMARY KEY (relationshipId, messageId),
      UNIQUE (relationshipId, serverSeq),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE
    );
    ALTER TABLE sync_outbox ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1));
    DROP INDEX sync_outbox_due;
    CREATE INDEX sync_outbox_due ON sync_outbox (relationshipId, blocked, nextAttemptAt, senderSeq);
    PRAGMA user_version = 4;
  `);
}

async function testLegacyMigration(version: 0 | 1): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, version);
    await insertValidLegacyFixture(db);
    await initializeDatabase(db);

    const currentVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(currentVersion?.user_version, 6, `v${version} legacy database should migrate to schema version 6`);

    const repository = new SQLiteRucolaRepository(db);
    const relationship = await repository.getRelationship();
    const active = await repository.getActiveMessage('PARTNER');
    const messages = await repository.getMessages();
    assert(relationship, 'Migration should preserve the relationship');
    assertEqual(active?.id, 'partner-message', 'Migration should preserve the active partner message');
    assertEqual(messages.length, 2, 'Migration should preserve all messages');
    assertEqual(messages.find((message) => message.id === 'old-message')?.isActive, false, 'Migration should preserve history state');
  });
}

async function testV2Migration(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createCurrentV2Schema(db);
    await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 6, 'v2 database should migrate to schema version 6');
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_state', 'sync_outbox', 'sync_inbox')",
    );
    assertEqual(tables.length, 3, 'v2 migration should create all sync tables');
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sync_outbox)');
    assert(columns.some((column) => column.name === 'blocked'), 'v2 migration should create blocked outbox state');
  });
}

async function testV3Migration(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createCurrentV3Schema(db);
    await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 6, 'v3 database should migrate to schema version 6');
    const inbox = await db.getFirstAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_inbox'");
    assertEqual(inbox?.name, 'sync_inbox', 'v3 migration should create sync_inbox');
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sync_outbox)');
    assert(columns.some((column) => column.name === 'blocked'), 'v3 migration should add blocked outbox state');
  });
}

async function testV4Migration(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createCurrentV4Schema(db);
    await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 6, 'v4 database should migrate to schema version 6');
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sync_outbox)');
    assert(columns.some((column) => column.name === 'blocked'), 'v4 migration should preserve blocked outbox state');
    assert(columns.some((column) => column.name === 'ciphertext'), 'v4 migration should add durable ciphertext');
    assert(columns.some((column) => column.name === 'encryptionVersion'), 'v4 migration should add encryption version');
  });
}

async function testV5Migration(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createCurrentV4Schema(db);
    await db.execAsync('PRAGMA user_version = 5;');
    await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 6, 'v5 database should migrate to schema version 6');
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sync_outbox)');
    assert(columns.some((column) => column.name === 'ciphertext'), 'v5 migration should add durable ciphertext');
    assert(columns.some((column) => column.name === 'encryptionVersion'), 'v5 migration should add encryption version');
  });
}

async function testRejectsLegacyCorruption(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 1);
    await db.runAsync(`INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince) VALUES ('the-one', 'Partner', 'Nico', '#8FC56A', NULL)`);
    await db.runAsync(`INSERT INTO active_message_slots (relationshipId, participant, messageId) VALUES ('the-one', 'PARTNER', 'missing-message')`);
    await assertRejects(() => initializeDatabase(db), 'Migration should reject an active slot referencing a missing message');
    await assertLegacySchemaPreserved(db, 1);
  });
}

async function testRejectsMismatchedActiveMessage(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 1);
    await insertValidLegacyFixture(db);
    await db.runAsync(`UPDATE active_message_slots SET participant = 'ME' WHERE relationshipId = 'the-one'`);
    await assertRejects(() => initializeDatabase(db), 'Migration should reject an active slot with the wrong participant');
    await assertLegacySchemaPreserved(db, 1);
  });
}

async function testRejectsInvalidActiveState(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 1);
    await insertValidLegacyFixture(db, { activeState: 2 });
    await assertRejects(() => initializeDatabase(db), 'Migration should reject an invalid legacy isActive value');
    await assertLegacySchemaPreserved(db, 1);
  });
}

async function testRollbackAfterTransformationFailure(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 1);
    await insertValidLegacyFixture(db, { createdAt: 'not-an-integer' });
    await assertRejects(() => initializeDatabase(db), 'Migration should reject an invalid legacy numeric field');
    await assertLegacySchemaPreserved(db, 1);
    const relationship = await db.getFirstAsync<{ id: string }>("SELECT id FROM relationships WHERE id = 'the-one'");
    assertEqual(relationship?.id, 'the-one', 'Rollback should preserve the legacy relationship');
  });
}

async function testRejectsIncompleteSchema(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await db.execAsync(`CREATE TABLE relationships (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL); PRAGMA user_version = 0;`);
    await assertRejects(() => initializeDatabase(db), 'Initialization should reject an incomplete legacy schema');
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 0, 'Incomplete schema rejection must preserve user_version');
  });
}

async function testRejectsNewerSchema(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await db.execAsync('PRAGMA user_version = 999;');
    await assertRejects(() => initializeDatabase(db), 'Initialization should reject a newer schema');
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 999, 'Newer schema rejection must preserve user_version');
  });
}

async function testInitializationFailureCanRetry(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await db.execAsync(`CREATE TABLE relationships (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL); PRAGMA user_version = 0;`);
    await assertRejects(() => initializeDatabase(db), 'Initialization should reject an incomplete schema before retry');
    await db.execAsync('DROP TABLE messages; DROP TABLE relationships;');
    await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 6, 'Initialization should retry successfully after a previous failure');
  });
}

export async function runMigrationIntegrationTests(): Promise<void> {
  await testLegacyMigration(0);
  await testLegacyMigration(1);
  await testV2Migration();
  await testV3Migration();
  await testV4Migration();
  await testV5Migration();
  await testRejectsLegacyCorruption();
  await testRejectsMismatchedActiveMessage();
  await testRejectsInvalidActiveState();
  await testRollbackAfterTransformationFailure();
  await testRejectsIncompleteSchema();
  await testRejectsNewerSchema();
  await testInitializationFailureCanRetry();
}
