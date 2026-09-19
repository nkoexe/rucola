import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';
import { initializeDatabase } from './database';
import { runMigrationIntegrationTests } from './migrationIntegration';
import { runRepositoryIntegrationTests } from './repositoryIntegration';
import { deleteOwnedMedia, persistPickedMedia, reconcileOwnedMedia } from './media';
import { runMediaRobustnessIntegrationTests } from './mediaRobustnessIntegration';
import { runSyncStateIntegrationTests } from './syncStateIntegration';
import { generateRelationshipKey } from '../crypto/relationshipKey';
import { AesGcmSyncCodec } from '../crypto/messageCodec';
import { expoAesGcmProvider } from '../crypto/expoAesGcm';
import { CloudIdentityStore } from '../cloud/CloudIdentityStore';
import { expoSecureValueStore } from '../cloud/expoSecureStore';

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
  assertEqual(version?.user_version, 5, 'Fresh database should use schema version 5');

  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relationships', 'messages', 'active_message_slots', 'sync_state', 'sync_outbox', 'sync_inbox')",
  );
  assertEqual(tables.length, 6, 'Fresh database should create all core and sync tables');

  const foreignKeys = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
  assertEqual(foreignKeys?.foreign_keys, 1, 'Foreign keys must be enabled');
}

async function testConcurrentInitialization(db: SQLite.SQLiteDatabase): Promise<void> {
  const results = await Promise.all(Array.from({ length: 10 }, () => initializeDatabase(db)));

  for (const result of results) {
    assertEqual(result, db, 'Concurrent initialization should resolve to the same database');
  }

  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  assertEqual(version?.user_version, 5, 'Concurrent initialization should leave a valid schema');

  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relationships', 'messages', 'active_message_slots', 'sync_state', 'sync_outbox', 'sync_inbox')",
  );
  assertEqual(tables.length, 6, 'Concurrent initialization should create each core and sync table exactly once');
}

async function testMessageLifecycle(db: SQLite.SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', partnerColor: '#8FC56A', togetherSince: null });

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

async function testConcurrentMessageOrdering(db: SQLite.SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', partnerColor: '#8FC56A', togetherSince: null });

  const sent = await Promise.all(
    Array.from({ length: 20 }, (_, index) => repository.sendMessage({ type: 'TEXT', body: `concurrent-${index}` })),
  );
  const messages = await repository.getMessages();
  const ownMessages = messages.filter((message) => message.participant === 'ME').sort((a, b) => a.orderIndex - b.orderIndex);

  assertEqual(ownMessages.length, 20, 'Concurrent sends should persist every message');
  assertEqual(new Set(sent.map((message) => message.id)).size, 20, 'Concurrent sends should generate unique message IDs');
  for (let index = 0; index < ownMessages.length; index += 1) {
    const message = ownMessages[index];
    assert(message, `Concurrent message at index ${index} should exist`);
    assertEqual(message.orderIndex, index + 2, 'Concurrent sends should allocate contiguous order indexes');
  }
  const lastMessage = ownMessages[ownMessages.length - 1];
  assert(lastMessage, 'Concurrent sends should produce a final message');
  assertEqual((await repository.getActiveMessage('ME'))?.id, lastMessage.id, 'Last committed concurrent send should be active');
}

async function testConcurrentRepositoryInstances(db: SQLite.SQLiteDatabase): Promise<void> {
  const firstRepository = new SQLiteRucolaRepository(db);
  const secondRepository = new SQLiteRucolaRepository(db);
  await firstRepository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', partnerColor: '#8FC56A', togetherSince: null });

  const sent = await Promise.all([
    ...Array.from({ length: 10 }, (_, index) => firstRepository.sendMessage({ type: 'TEXT', body: `repo-a-${index}` })),
    ...Array.from({ length: 10 }, (_, index) => secondRepository.sendMessage({ type: 'TEXT', body: `repo-b-${index}` })),
  ]);

  const messages = await firstRepository.getMessages();
  const ownMessages = messages.filter((message) => message.participant === 'ME').sort((a, b) => a.orderIndex - b.orderIndex);

  assertEqual(ownMessages.length, 20, 'Concurrent repository instances should persist every message');
  assertEqual(new Set(sent.map((message) => message.id)).size, 20, 'Concurrent repository instances should generate unique message IDs');
  for (let index = 0; index < ownMessages.length; index += 1) {
    const message = ownMessages[index];
    assert(message, `Concurrent repository message at index ${index} should exist`);
    assertEqual(message.orderIndex, index + 2, 'Concurrent repository instances should allocate contiguous order indexes');
  }

  const active = await firstRepository.getActiveMessage('ME');
  assert(active, 'Concurrent repository sends should leave an active message');
  assertEqual(active.id, ownMessages[ownMessages.length - 1]?.id, 'Active message should be the highest committed message');
}

async function testPersistenceAcrossRepositoryInstances(db: SQLite.SQLiteDatabase): Promise<void> {
  const firstRepository = new SQLiteRucolaRepository(db);
  await firstRepository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', partnerColor: '#8FC56A', togetherSince: 123456789 });
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
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', partnerColor: '#8FC56A', togetherSince: null });
  await repository.sendMessage({ type: 'TEXT', body: 'temporary' });
  await repository.deleteRelationship();

  assertEqual(await repository.getRelationship(), null, 'Reset should delete the relationship');
  assertEqual((await repository.getMessages()).length, 0, 'Reset should delete all messages');
}

async function testCryptoAndSecureStorage(): Promise<void> {
  const relationshipKey = await generateRelationshipKey();
  assert(relationshipKey.length > 0, 'Relationship key generation should return encoded key material');

  const identityStore = new CloudIdentityStore(expoSecureValueStore, 'rucola.native-security-test.v1');
  await identityStore.save({
    relationshipId: 'native-security-test',
    deviceId: 'native-security-device',
    participant: 'ME',
    state: 'ACTIVE' as const,
    credential: 'native-security-credential',
    relationshipKey,
  });

  try {
    const restored = await identityStore.load();
    assert(restored, 'Secure identity should be readable after persistence');
    assertEqual(restored.relationshipKey, relationshipKey, 'Secure identity should preserve the relationship key');

    const codec = new AesGcmSyncCodec({
      relationshipId: restored.relationshipId,
      relationshipKey: restored.relationshipKey,
      provider: expoAesGcmProvider,
    });
    const message = {
      id: 'native-security-message',
      relationshipId: restored.relationshipId,
      participant: 'ME' as const,
      type: 'TEXT' as const,
      body: 'native crypto test 🌶️',
      createdAt: Date.now(),
      isActive: true,
      syncState: 'PENDING' as const,
      orderIndex: 1,
      mediaReference: null,
    };
    const ciphertext = await codec.encrypt(message, 1);
    const decoded = await codec.decrypt({
      messageId: message.id,
      senderSeq: 1,
      type: message.type,
      encryptionVersion: codec.encryptionVersion,
      ciphertext,
    });

    assertEqual(decoded.body, message.body, 'Native AES-GCM should round-trip Unicode text');
    assertEqual(decoded.type, message.type, 'Native AES-GCM should preserve message type');
    await assertRejects(
      () => codec.decrypt({
        messageId: message.id,
        senderSeq: 2,
        type: message.type,
        encryptionVersion: codec.encryptionVersion,
        ciphertext,
      }),
      'Native AES-GCM should reject tampered authenticated context',
    );
  } finally {
    await identityStore.clear();
  }

  assertEqual(await identityStore.load(), null, 'Secure identity reset should remove stored key material');
}

async function testMediaLifecycle(): Promise<void> {
  const documentDirectory = FileSystem.documentDirectory;
  assert(documentDirectory, 'Document storage should be available for native media tests');

  const source = `${documentDirectory}rucola-test-source-${Date.now()}.txt`;
  const persistedUris: string[] = [];
  try {
    await FileSystem.writeAsStringAsync(source, 'native media test');

    await assertRejects(
      () => persistPickedMedia({ uri: '   ', type: 'image' } as Parameters<typeof persistPickedMedia>[0]),
      'Media persistence should reject an empty source URI',
    );

    const persisted = await persistPickedMedia({ uri: source, fileName: 'test-photo.jpg', mimeType: 'image/jpeg', type: 'image', width: 1, height: 1 });
    persistedUris.push(persisted);

    assert(persisted.startsWith(`${documentDirectory}media/`), 'Persisted media must live under the app media directory');
    assert(await FileSystem.getInfoAsync(persisted).then((info) => info.exists), 'Persisted media file should exist');

    const videoPersisted = await persistPickedMedia({ uri: source, fileName: 'video.jpg', mimeType: 'video/mp4', type: 'video', duration: 1, width: 1, height: 1 });
    persistedUris.push(videoPersisted);
    assert(videoPersisted.endsWith('.mp4'), 'Video MIME type should determine the stored extension');

    const mediaDirectory = `${documentDirectory}media/`;
    const orphan = `${mediaDirectory}rucola-test-orphan-${Date.now()}.jpg`;
    await FileSystem.makeDirectoryAsync(mediaDirectory, { intermediates: true });
    await FileSystem.writeAsStringAsync(orphan, 'orphan');
    try {
      await reconcileOwnedMedia([persisted, videoPersisted]);
      assert(await FileSystem.getInfoAsync(persisted).then((info) => info.exists), 'Referenced media must survive reconciliation');
      assert(await FileSystem.getInfoAsync(videoPersisted).then((info) => info.exists), 'Referenced video must survive reconciliation');
      assert(!(await FileSystem.getInfoAsync(orphan)).exists, 'Unreferenced owned media should be reconciled');
    } finally {
      await FileSystem.deleteAsync(orphan, { idempotent: true }).catch(() => undefined);
    }

    await deleteOwnedMedia(persisted);
    assert(!(await FileSystem.getInfoAsync(persisted)).exists, 'Owned media should be deleted');

    const outside = `${documentDirectory}rucola-test-outside-${Date.now()}.txt`;
    await FileSystem.writeAsStringAsync(outside, 'must remain');
    try {
      await deleteOwnedMedia(outside);
      assert(await FileSystem.getInfoAsync(outside).then((info) => info.exists), 'Non-media files must not be deleted');
    } finally {
      await FileSystem.deleteAsync(outside, { idempotent: true });
    }
  } finally {
    for (const uri of persistedUris) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(source, { idempotent: true }).catch(() => undefined);
  }
}

const coreTests: Array<[string, (db: SQLite.SQLiteDatabase) => Promise<void>]> = [
  ['fresh database', testFreshDatabase],
  ['concurrent initialization', testConcurrentInitialization],
  ['message lifecycle', testMessageLifecycle],
  ['concurrent message ordering', testConcurrentMessageOrdering],
  ['concurrent repository instances', testConcurrentRepositoryInstances],
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
      results.push({ name, passed: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  try {
    await withTestDatabase(runRepositoryIntegrationTests);
    results.push({ name: 'real SQLite repository integration suite', passed: true });
  } catch (cause) {
    results.push({ name: 'real SQLite repository integration suite', passed: false, error: cause instanceof Error ? cause.message : String(cause) });
  }

  try {
    await withTestDatabase(runSyncStateIntegrationTests);
    results.push({ name: 'durable local sync state integration suite', passed: true });
  } catch (cause) {
    results.push({ name: 'durable local sync state integration suite', passed: false, error: cause instanceof Error ? cause.message : String(cause) });
  }

  try {
    await testMediaLifecycle();
    results.push({ name: 'media persistence, validation, reconciliation and cleanup', passed: true });
  } catch (cause) {
    results.push({ name: 'media persistence, validation, reconciliation and cleanup', passed: false, error: cause instanceof Error ? cause.message : String(cause) });
  }

  try {
    await runMediaRobustnessIntegrationTests();
    results.push({ name: 'media robustness edge cases', passed: true });
  } catch (cause) {
    results.push({ name: 'media robustness edge cases', passed: false, error: cause instanceof Error ? cause.message : String(cause) });
  }

  try {
    await testCryptoAndSecureStorage();
    results.push({ name: 'secure identity and native AES-GCM crypto', passed: true });
  } catch (cause) {
    results.push({ name: 'secure identity and native AES-GCM crypto', passed: false, error: cause instanceof Error ? cause.message : String(cause) });
  }

  try {
    await runMigrationIntegrationTests();
    results.push({ name: 'migration fixtures and rollback', passed: true });
  } catch (cause) {
    results.push({ name: 'migration fixtures and rollback', passed: false, error: cause instanceof Error ? cause.message : String(cause) });
  }

  return results;
}
