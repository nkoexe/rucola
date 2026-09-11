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

async function testMediaReferenceOwnership(db: SQLiteDatabase): Promise<void> {
  const directory = FileSystem.documentDirectory;
  assert(directory, 'Document storage is required for media reference validation');
  const repository = new SQLiteRucolaRepository(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });

  const ownedReference = `${directory}media/reference-validation.jpg`;
  const validMessage = await repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference: ownedReference });
  assertEqual(validMessage.mediaReference, ownedReference, 'Owned media references should be persisted unchanged');

  await assertRejects(
    () => repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference: `${directory}other/file.jpg` }),
    'Repository must reject media references outside the owned media directory',
  );
  await assertRejects(
    () => repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference: `${directory}media/../outside.jpg` }),
    'Repository must reject path traversal media references',
  );
  await assertRejects(
    () => repository.sendMessage({ type: 'PHOTO_VIDEO', body: '', mediaReference: 'content://media/external-photo' }),
    'Repository must reject external media URIs',
  );
  await assertRejects(
    () => repository.sendMessage({ type: 'TEXT', body: 'no media here', mediaReference: ownedReference }),
    'Repository must reject media references on non-media messages',
  );

  const messages = await repository.getMessages();
  assertEqual(messages.filter((message) => message.mediaReference === ownedReference).length, 1, 'Rejected media references must not be persisted');
}

async function testSerializedMediaCleanup(db: SQLiteDatabase): Promise<void> {
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
  const directory = FileSystem.documentDirectory;
  assert(directory, 'Document storage is required for serialized media cleanup testing');
  const mediaReference = `${directory}media/cleanup-race.jpg`;
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
  await testMediaReferenceOwnership(db);
  await testSerializedMediaCleanup(db);
  await testResetAndMediaCleanup(db);
}
