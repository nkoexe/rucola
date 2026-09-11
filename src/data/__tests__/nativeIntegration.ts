import * as SQLite from 'expo-sqlite';
import { SQLiteRucolaRepository } from '../SQLiteRucolaRepository';
import { initializeDatabase } from '../database';
import { runMigrationIntegrationTests } from './migrationIntegration';

export type NativeIntegrationResult = {
  name: string;
  passed: boolean;
  error?: string;
};

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

async function withTestDatabase<T>(test: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const databaseName = `rucola-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const db = await SQLite.openDatabaseAsync(databaseName);
  try {
    await initializeDatabase(db);
    return await test(db);
  } finally {
    await db.closeAsync();
    await SQLite.deleteDatabaseAsync(databaseName).catch(() => undefined);
  }
}

async function testFreshDatabase(db: SQLite.SQLiteDatabase): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  assertEqual(version?.user_version, 2, 'Fresh database should use schema version 2');

  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relationships', 'messages', 'active_message_slots')",
  );
  assertEqual(tables.length, 3, 'Fresh database should create all core tables');

  const foreignKeys = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
  assertEqual(foreignKeys?.foreign_keys, 1, 'Foreign keys must be enabled');
}

async function testMessageLifecycle(db: SQLite.SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({
    partnerNickname: 'Partner',
    ownName: 'Nico',
    partnerColor: '#8FC56A',
    togetherSince: null,
  });

  const seeded = await repository.getActiveMessage('PARTNER');
  assert(seeded, 'Setup should seed an active partner message');
  assertEqual(seeded.participant, 'PARTNER', 'Seeded message must belong to partner');

  const first = await repository.sendMessage({ type: 'TEXT', body: 'first' });
  const second = await repository.sendMessage({ type: 'TEXT', body: 'second' });
  const messages = await repository.getMessages();

  assertEqual(messages.length, 3, 'Two sent messages plus the seed should exist');
  assertEqual((await repository.getActiveMessage('ME'))?.id, second.id, 'Latest sent message should be active');
  assertEqual((await repository.getActiveMessage('PARTNER'))?.id, seeded.id, 'Partner seed should remain active');

  const firstStored = messages.find((message) => message.id === first.id);
  assert(firstStored, 'First sent message should remain in history');
  assertEqual(firstStored.isActive, false, 'Previous own message should become history');
  assertEqual(second.orderIndex, first.orderIndex + 1, 'Message ordering should increase monotonically');
}

async function testPersistenceAcrossRepositoryInstances(db: SQLite.SQLiteDatabase): Promise<void> {
  const firstRepository = new SQLiteRucolaRepository(db);
  await firstRepository.saveSetup({
    partnerNickname: 'Partner',
    ownName: 'Nico',
    togetherSince: 123456789,
  });
  const sent = await firstRepository.sendMessage({ type: 'EMOJI', body: '♡' });

  const secondRepository = new SQLiteRucolaRepository(db);
  const relationship = await secondRepository.getRelationship();
  const active = await secondRepository.getActiveMessage('ME');

  assert(relationship, 'Relationship should persist');
  assertEqual(relationship.ownName, 'Nico', 'Persisted relationship should retain own name');
  assertEqual(relationship.togetherSince, 123456789, 'Persisted relationship should retain togetherSince');
  assertEqual(active?.id, sent.id, 'Active message should persist across repository instances');
}

async function testForeignKeyInvariant(db: SQLite.SQLiteDatabase): Promise<void> {
  await assertRejects(
    () => db.runAsync(
      `INSERT INTO active_message_slots (relationshipId, participant, messageId)
       VALUES (?, 'ME', ?)`,
      'missing-relationship',
      'missing-message',
    ),
    'Foreign-key enforcement should reject an invalid active slot',
  );
}

async function testReset(db: SQLite.SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });
  await repository.sendMessage({ type: 'TEXT', body: 'temporary' });
  await repository.deleteRelationship();

  assertEqual(await repository.getRelationship(), null, 'Reset should delete the relationship');
  assertEqual((await repository.getMessages()).length, 0, 'Reset should delete all messages');
}

const coreTests: Array<[string, (db: SQLite.SQLiteDatabase) => Promise<void>]> = [
  ['fresh database', testFreshDatabase],
  ['message lifecycle', testMessageLifecycle],
  ['persistence across repository instances', testPersistenceAcrossRepositoryInstances],
  ['foreign-key invariant', testForeignKeyInvariant],
  ['relationship reset', testReset],
];

export async function runNativeIntegrationTests(): Promise<NativeIntegrationResult[]> {
  const results: NativeIntegrationResult[] = [];

  for (const [name, test] of coreTests) {
    try {
      await withTestDatabase(test);
      results.push({ name, passed: true });
    } catch (cause) {
      results.push({
        name,
        passed: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  try {
    await runMigrationIntegrationTests();
    results.push({ name: 'migration fixtures and rollback', passed: true });
  } catch (cause) {
    results.push({
      name: 'migration fixtures and rollback',
      passed: false,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  return results;
}
