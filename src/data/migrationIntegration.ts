import * as SQLite from 'expo-sqlite';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';
import { initializeDatabase } from './database';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function assertEqual<T>(actual: T, expected: T, message: string): void { if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`); }
async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> { try { await action(); } catch { return; } throw new Error(message); }

async function withRawTestDatabase<T>(test: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const databaseName = `rucola-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const db = await SQLite.openDatabaseAsync(databaseName);
  try { await db.execAsync('PRAGMA foreign_keys = ON;'); return await test(db); }
  finally { await db.closeAsync(); await SQLite.deleteDatabaseAsync(databaseName).catch(() => undefined); }
}

async function createLegacySchema(db: SQLite.SQLiteDatabase, version: 0 | 1): Promise<void> {
  await db.execAsync(`
    CREATE TABLE relationships (id TEXT PRIMARY KEY NOT NULL, partnerNickname TEXT NOT NULL, ownName TEXT NOT NULL, partnerColor TEXT NOT NULL, togetherSince INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, relationshipId TEXT NOT NULL, participant TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL, orderIndex INTEGER NOT NULL, isActive INTEGER NOT NULL, mediaReference TEXT, syncState TEXT NOT NULL, FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE);
    CREATE TABLE active_message_slots (relationshipId TEXT NOT NULL, participant TEXT NOT NULL, messageId TEXT NOT NULL, PRIMARY KEY (relationshipId, participant), FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE);
    PRAGMA user_version = ${version};
  `);
}

async function insertValidLegacyFixture(db: SQLite.SQLiteDatabase, options: { createdAt?: number | string; activeState?: number } = {}): Promise<void> {
  const { createdAt = 1000, activeState = 1 } = options;
  await db.runAsync(`INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince) VALUES ('the-one', 'Partner', 'Nico', '#8FC56A', 123456789)`);
  await db.runAsync(`INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, isActive, mediaReference, syncState) VALUES ('partner-message', 'the-one', 'PARTNER', 'TEXT', 'hello', ?, 0, ?, NULL, 'SYNCED')`, createdAt, activeState);
  await db.runAsync(`INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, isActive, mediaReference, syncState) VALUES ('old-message', 'the-one', 'ME', 'TEXT', 'old', 900, 1, 0, NULL, 'LOCAL_ONLY')`);
  await db.runAsync(`INSERT INTO active_message_slots (relationshipId, participant, messageId) VALUES ('the-one', 'PARTNER', 'partner-message')`);
}

async function assertLegacySchemaPreserved(db: SQLite.SQLiteDatabase, expectedVersion: 0 | 1): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  assertEqual(version?.user_version, expectedVersion, 'Failed migration must preserve the original schema version');
  const messageColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)');
  assert(messageColumns.some((column) => column.name === 'isActive'), 'Failed migration must preserve the legacy messages schema');
  const legacyTables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_legacy'");
  assertEqual(legacyTables.length, 0, 'Failed migration must not leave temporary renamed tables behind');
}

async function testV0Migration(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 0); await insertValidLegacyFixture(db); await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 3, 'v0 legacy database should migrate to schema version 3');
    const repository = new SQLiteRucolaRepository(db); const relationship = await repository.getRelationship(); const active = await repository.getActiveMessage('PARTNER'); const messages = await repository.getMessages();
    assert(relationship, 'v0 migration should preserve the relationship');
    assertEqual(relationship.partnerNickname, 'Partner', 'v0 migration should preserve relationship data');
    assertEqual(active?.id, 'partner-message', 'v0 migration should preserve the active partner message');
    assertEqual(messages.length, 2, 'v0 migration should preserve all messages');
    assertEqual(messages.find((message) => message.id === 'old-message')?.isActive, false, 'v0 history state should be preserved');
  });
}

async function testV1Migration(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 1); await insertValidLegacyFixture(db); await initializeDatabase(db);
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assertEqual(version?.user_version, 3, 'v1 legacy database should migrate to schema version 3');
    const repository = new SQLiteRucolaRepository(db);
    assertEqual((await repository.getActiveMessage('PARTNER'))?.id, 'partner-message', 'v1 migration should preserve active state');
    assertEqual((await repository.getMessages()).length, 2, 'v1 migration should preserve all messages');
  });
}

async function testRejectsMissingActiveMessage(): Promise<void> { await withRawTestDatabase(async (db) => { await createLegacySchema(db, 1); await db.runAsync(`INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince) VALUES ('the-one', 'Partner', 'Nico', '#8FC56A', NULL)`); await db.runAsync(`INSERT INTO active_message_slots (relationshipId, participant, messageId) VALUES ('the-one', 'PARTNER', 'missing-message')`); await assertRejects(() => initializeDatabase(db), 'Migration should reject an active slot that references a missing message'); await assertLegacySchemaPreserved(db, 1); }); }
async function testRejectsMismatchedActiveMessage(): Promise<void> { await withRawTestDatabase(async (db) => { await createLegacySchema(db, 1); await insertValidLegacyFixture(db); await db.runAsync(`UPDATE active_message_slots SET participant = 'ME' WHERE relationshipId = 'the-one'`); await assertRejects(() => initializeDatabase(db), 'Migration should reject an active slot whose participant disagrees with the message'); await assertLegacySchemaPreserved(db, 1); }); }
async function testRejectsInvalidActiveState(): Promise<void> { await withRawTestDatabase(async (db) => { await createLegacySchema(db, 1); await insertValidLegacyFixture(db, { activeState: 2 }); await assertRejects(() => initializeDatabase(db), 'Migration should reject an invalid legacy isActive value'); await assertLegacySchemaPreserved(db, 1); }); }
async function testRejectsOrphanActiveMessage(): Promise<void> { await withRawTestDatabase(async (db) => { await createLegacySchema(db, 1); await insertValidLegacyFixture(db); await db.runAsync(`UPDATE messages SET isActive = 1 WHERE id = 'old-message'`); await assertRejects(() => initializeDatabase(db), 'Migration should reject an active message without a matching active slot'); await assertLegacySchemaPreserved(db, 1); }); }

async function testRollbackAfterTransformationFailure(): Promise<void> {
  await withRawTestDatabase(async (db) => {
    await createLegacySchema(db, 1); await insertValidLegacyFixture(db, { createdAt: 'not-an-integer' });
    await assertRejects(() => initializeDatabase(db), 'Migration should reject an invalid numeric legacy field'); await assertLegacySchemaPreserved(db, 1);
    const relationship = await db.getFirstAsync<{ id: string }>(`SELECT id FROM relationships WHERE id = 'the-one'`);
    const activeSlot = await db.getFirstAsync<{ messageId: string }>(`SELECT messageId FROM active_message_slots WHERE relationshipId = 'the-one' AND participant = 'PARTNER'`);
    assertEqual(relationship?.id, 'the-one', 'Rollback should preserve the legacy relationship'); assertEqual(activeSlot?.messageId, 'partner-message', 'Rollback should preserve the legacy active slot');
  });
}

async function testRejectsIncompleteSchema(): Promise<void> { await withRawTestDatabase(async (db) => { await db.execAsync(`CREATE TABLE relationships (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL); PRAGMA user_version = 0;`); await assertRejects(() => initializeDatabase(db), 'Initialization should reject a version-0 database with an incomplete legacy schema'); const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'); assertEqual(version?.user_version, 0, 'Incomplete schema rejection must not change user_version'); }); }
async function testRejectsNewerSchema(): Promise<void> { await withRawTestDatabase(async (db) => { await db.execAsync('PRAGMA user_version = 999;'); await assertRejects(() => initializeDatabase(db), 'Initialization should reject a database newer than the supported schema version'); const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'); assertEqual(version?.user_version, 999, 'Newer schema rejection must preserve user_version'); }); }
async function testInitializationFailureCanRetry(): Promise<void> { await withRawTestDatabase(async (db) => { await db.execAsync(`CREATE TABLE relationships (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL); PRAGMA user_version = 0;`); await assertRejects(() => initializeDatabase(db), 'Initialization should reject an incomplete schema before retry'); await db.execAsync('DROP TABLE messages; DROP TABLE relationships;'); await initializeDatabase(db); const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'); assertEqual(version?.user_version, 3, 'Initialization should retry successfully after a previous failure'); }); }

export async function runMigrationIntegrationTests(): Promise<void> {
  await testV0Migration(); await testV1Migration(); await testRejectsMissingActiveMessage(); await testRejectsMismatchedActiveMessage(); await testRejectsInvalidActiveState(); await testRejectsOrphanActiveMessage(); await testRollbackAfterTransformationFailure(); await testRejectsIncompleteSchema(); await testRejectsNewerSchema(); await testInitializationFailureCanRetry();
}
