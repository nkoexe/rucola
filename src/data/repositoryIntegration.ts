import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';
import { persistPickedMedia } from './media';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try { await action(); } catch { return; }
  throw new Error(message);
}

async function testFreshAndPersistedSetup(db: SQLiteDatabase): Promise<void> {
  const first = new SQLiteRucolaRepository(db);
  assertEqual(await first.getRelationship(), null, 'Fresh repository should have no relationship');
  await first.saveSetup({ partnerNickname: ' Partner ', ownName: ' Nico ', togetherSince: 123 });
  const second = new SQLiteRucolaRepository(db);
  const relationship = await second.getRelationship();
  assert(relationship, 'Setup should persist a relationship');
  assertEqual(relationship.partnerNickname, 'Partner', 'Setup should trim partner nickname');
  assertEqual(relationship.ownName, 'Nico', 'Setup should trim own name');
  assertEqual((await second.getActiveMessage('PARTNER'))?.body, 'good luck today ♡', 'Setup should seed the partner message');
  await second.saveSetup({ partnerNickname: 'New Partner', ownName: 'New Nico', togetherSince: 456 });
  assertEqual((await first.getRelationship())?.partnerNickname, 'New Partner', 'Repeated setup should update persisted relationship');
  assertEqual((await first.getMessages()).filter((message) => message.participant === 'PARTNER').length, 1, 'Repeated setup must not duplicate the seed message');
}

async function testReinitialization(db: SQLiteDatabase): Promise<void> {
  const first = new SQLiteRucolaRepository(db);
  await first.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });
  const sent = await first.sendMessage({ type: 'TEXT', body: 'survives reinitialization' });
  const reopened = new SQLiteRucolaRepository(db);
  assertEqual((await reopened.getActiveMessage('ME'))?.id, sent.id, 'Reinitialized repository should recover the active message');
  assertEqual((await reopened.getMessages()).find((message) => message.id === sent.id)?.body, sent.body, 'Reinitialized repository should recover message data');
}

async function testActiveReplacementAndHistoryImmutability(db: SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });
  const first = await repository.sendMessage({ type: 'TEXT', body: 'immutable first' });
  const second = await repository.sendMessage({ type: 'TEXT', body: 'current second' });
  assertEqual((await repository.getActiveMessage('ME'))?.id, second.id, 'Newest own message should replace the active slot');
  const history = (await repository.getMessages()).find((message) => message.id === first.id);
  assert(history, 'Replaced message should remain in history');
  assertEqual(history.body, 'immutable first', 'History body must remain immutable');
  assertEqual(history.orderIndex, first.orderIndex, 'History order must remain immutable');
  assertEqual(history.isActive, false, 'Replaced message must remain inactive');
  assertEqual((await repository.getMessages()).filter((message) => message.id === first.id).length, 1, 'Replacement must not duplicate history');
}

async function testRapidConcurrentWrites(db: SQLiteDatabase): Promise<void> {
  const first = new SQLiteRucolaRepository(db);
  const second = new SQLiteRucolaRepository(db);
  await first.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });
  const sent = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    (index % 2 === 0 ? first : second).sendMessage({ type: 'TEXT', body: `rapid-${index}` }),
  ));
  const own = (await first.getMessages()).filter((message) => message.participant === 'ME').sort((a, b) => a.orderIndex - b.orderIndex);
  assertEqual(own.length, 50, 'Rapid concurrent writes must persist every message');
  assertEqual(new Set(sent.map((message) => message.id)).size, 50, 'Rapid concurrent writes must use unique IDs');
  assertEqual(new Set(own.map((message) => message.orderIndex)).size, 50, 'Rapid concurrent writes must use unique order indexes');
  for (let i = 0; i < own.length; i += 1) assertEqual(own[i]?.orderIndex, i + 2, 'Rapid writes must keep contiguous ordering');
  assertEqual((await first.getActiveMessage('ME'))?.id, own.at(-1)?.id, 'Final committed write must own the active slot');
}

async function testInvariantViolations(db: SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await assertRejects(() => repository.saveSetup({ partnerNickname: '   ', ownName: 'Nico', togetherSince: null }), 'Repository boundary must reject blank partner names');
  await assertRejects(() => repository.sendMessage({ type: 'TEXT', body: '   ' }), 'Repository boundary must reject empty text messages');
  await assertRejects(() => db.runAsync(`INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState)
    VALUES ('orphan', 'missing', 'ME', 'TEXT', 'x', 1, 1, NULL, 'LOCAL_ONLY')`), 'Foreign-key invariant must reject an orphan message');
  await assertRejects(() => db.runAsync(`INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState)
    VALUES ('invalid-participant', 'the-one', 'NOPE', 'TEXT', 'x', 1, 1, NULL, 'LOCAL_ONLY')`), 'Participant CHECK invariant must reject invalid participants');
  await assertRejects(() => db.runAsync(`INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState)
    VALUES ('invalid-type', 'the-one', 'ME', 'NOPE', 'x', 1, 1, NULL, 'LOCAL_ONLY')`), 'Message type CHECK invariant must reject invalid types');
}

async function testMediaReferenceInvariant(db: SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });

  const messageCount = async (): Promise<number> => (await repository.getMessages()).length;
  const before = await messageCount();

  await assertRejects(
    () => repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference: 'content://external/photo' }),
    'External media URI must be rejected',
  );
  await assertRejects(
    () => repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference: 'file:///rucola/media/../outside.jpg' }),
    'Path traversal media URI must be rejected',
  );
  await assertRejects(
    () => repository.sendMessage({ type: 'TEXT', body: 'text', mediaReference: 'file:///external/photo.jpg' }),
    'Non-media messages must not carry media references',
  );
  assertEqual(await messageCount(), before, 'Rejected media references must not mutate message state');
}

async function testResetRecreatesCleanState(db: SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Old Partner', ownName: 'Old Nico', togetherSince: null });
  await repository.sendMessage({ type: 'TEXT', body: 'old message' });

  await repository.deleteRelationship();
  assertEqual(await repository.getRelationship(), null, 'Reset should remove the old relationship');
  assertEqual((await repository.getMessages()).length, 0, 'Reset should remove old messages');
  assertEqual(await repository.getActiveMessage('ME'), null, 'Reset should remove the own active slot');
  assertEqual(await repository.getActiveMessage('PARTNER'), null, 'Reset should remove the partner active slot');

  await repository.saveSetup({ partnerNickname: 'New Partner', ownName: 'New Nico', togetherSince: 789 });
  const sent = await repository.sendMessage({ type: 'TEXT', body: 'new message' });
  assertEqual((await repository.getRelationship())?.partnerNickname, 'New Partner', 'Setup after reset must create a fresh relationship');
  assertEqual((await repository.getMessages()).filter((message) => message.participant === 'ME').length, 1, 'Fresh state must not retain old own messages');
  assertEqual((await repository.getActiveMessage('ME'))?.id, sent.id, 'Fresh state should accept new messages normally');
  assertEqual((await repository.getActiveMessage('PARTNER'))?.body, 'good luck today ♡', 'Fresh setup should recreate the partner seed');
}

async function testConcurrentSetupIsIdempotent(db: SQLiteDatabase): Promise<void> {
  const first = new SQLiteRucolaRepository(db);
  const second = new SQLiteRucolaRepository(db);
  await Promise.all([
    first.saveSetup({ partnerNickname: 'Partner A', ownName: 'Nico A', togetherSince: 1 }),
    second.saveSetup({ partnerNickname: 'Partner B', ownName: 'Nico B', togetherSince: 2 }),
  ]);

  const relationship = await first.getRelationship();
  assert(relationship, 'Concurrent setup should leave a relationship');
  assert(
    (relationship.partnerNickname === 'Partner A' && relationship.ownName === 'Nico A' && relationship.togetherSince === 1)
      || (relationship.partnerNickname === 'Partner B' && relationship.ownName === 'Nico B' && relationship.togetherSince === 2),
    'Concurrent setup must leave one complete setup state rather than mixed fields',
  );
  assertEqual((await first.getMessages()).filter((message) => message.participant === 'PARTNER').length, 1, 'Concurrent setup must create only one partner seed');
  assert((await first.getActiveMessage('PARTNER')) !== null, 'Concurrent setup must leave a valid partner active slot');
}

async function testSerializedMediaCleanup(db: SQLiteDatabase): Promise<void> {
  const directory = FileSystem.documentDirectory;
  assert(directory, 'Document storage is required for serialized media cleanup testing');
  let cleanupStartedResolve!: () => void;
  let releaseCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => { cleanupStartedResolve = resolve; });
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const cleanupReferences: string[] = [];
  const repository = new SQLiteRucolaRepository(db, async (uri) => {
    cleanupReferences.push(uri);
    cleanupStartedResolve();
    await cleanupGate;
  });

  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });
  const mediaReference = `${directory}media/rucola-media-cleanup-race.jpg`;
  await repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference });

  let resetSettled = false;
  const resetPromise = repository.deleteRelationship().finally(() => { resetSettled = true; });
  await cleanupStarted;

  let sendError: unknown = null;
  let sendSettled = false;
  const sendPromise = repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference }).catch((cause) => { sendError = cause; }).finally(() => { sendSettled = true; });

  await Promise.resolve();
  await Promise.resolve();
  assertEqual(resetSettled, false, 'Relationship reset must remain pending until media cleanup finishes');
  assertEqual(sendSettled, false, 'A following repository write must remain queued until media cleanup finishes');
  assertEqual(cleanupReferences.length, 1, 'Reset should clean each referenced media file once');
  assertEqual(cleanupReferences[0], mediaReference, 'Reset should clean the referenced media file');

  releaseCleanup();
  await resetPromise;
  await sendPromise;
  assert(sendError instanceof Error, 'A write queued behind reset should observe the reset relationship state');
  assertEqual(await repository.getRelationship(), null, 'Reset should leave the relationship deleted');
}

async function testResetAndMediaCleanup(db: SQLiteDatabase): Promise<void> {
  const directory = FileSystem.documentDirectory;
  assert(directory, 'Document storage is required for reset media testing');
  const source = `${directory}rucola-reset-source-${Date.now()}.txt`;
  await FileSystem.writeAsStringAsync(source, 'reset test');
  try {
    const repository = new SQLiteRucolaRepository(db);
    await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });
    const mediaReference = await persistPickedMedia({ uri: source, fileName: 'reset.jpg', mimeType: 'image/jpeg', type: 'image', width: 1, height: 1 });
    await repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference });
    assert((await FileSystem.getInfoAsync(mediaReference)).exists, 'Media must exist before reset');
    await repository.deleteRelationship();
    assertEqual(await repository.getRelationship(), null, 'Reset must remove the relationship');
    assertEqual((await repository.getMessages()).length, 0, 'Reset must remove all messages');
    assert(!(await FileSystem.getInfoAsync(mediaReference)).exists, 'Reset must remove owned media referenced by messages');
  } finally {
    await FileSystem.deleteAsync(source, { idempotent: true }).catch(() => undefined);
  }
}

export async function runRepositoryIntegrationTests(db: SQLiteDatabase): Promise<void> {
  await testFreshAndPersistedSetup(db);
  await testReinitialization(db);
  await testActiveReplacementAndHistoryImmutability(db);
  await testRapidConcurrentWrites(db);
  await testInvariantViolations(db);
  await testMediaReferenceInvariant(db);
  await testResetRecreatesCleanState(db);
  await testConcurrentSetupIsIdempotent(db);
  await testSerializedMediaCleanup(db);
  await testResetAndMediaCleanup(db);
}
