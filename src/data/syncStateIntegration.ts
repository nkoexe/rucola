import type * as SQLite from 'expo-sqlite';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';
import { SQLiteSyncStateStore } from './SQLiteSyncStateStore';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try { await action(); } catch { return; }
  throw new Error(message);
}

export async function runSyncStateIntegrationTests(db: SQLite.SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  const store = new SQLiteSyncStateStore({ database: db });
  const createdAt = Date.UTC(2026, 0, 1);

  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', partnerColor: '#8FC56A', togetherSince: null });
  const initial = await store.getState();
  assertEqual(initial.nextSenderSeq, 1, 'Fresh sync state should start sender sequences at one');
  assertEqual(initial.pullCursor, 0, 'Fresh sync state should start the pull cursor at zero');

  await store.setDevice('device-a', 'ME');
  const configured = await store.getState();
  assertEqual(configured.deviceId, 'device-a', 'Device identity should persist locally');
  assertEqual(configured.participant, 'ME', 'Participant role should persist locally');

  const first = await repository.sendMessage({ type: 'TEXT', body: 'first' });
  const second = await repository.sendMessage({ type: 'TEXT', body: 'second' });
  const [firstSeqA, firstSeqB] = await Promise.all([store.reserveSenderSequence(first.id), store.reserveSenderSequence(first.id)]);
  assertEqual(firstSeqA, 1, 'First message should receive sender sequence one');
  assertEqual(firstSeqB, 1, 'Concurrent reservation of one message must be idempotent');
  assertEqual(await store.reserveSenderSequence(second.id), 2, 'Second message should receive sender sequence two');

  const outbox = await store.getPendingOutbox(10);
  assertEqual(outbox.length, 2, 'Both reserved messages should be visible in the durable outbox');
  assertEqual(outbox[0]?.senderSeq, 1, 'Outbox must preserve sender ordering');
  assertEqual(outbox[1]?.senderSeq, 2, 'Outbox must preserve sender ordering');
  assertEqual(outbox[0]?.ciphertext, null, 'New outbox rows must not invent ciphertext before encryption');
  assertEqual(outbox[0]?.encryptionVersion, null, 'New outbox rows must not invent an encryption version');

  await store.storeOutboundCiphertext(first.id, 'v1.iv.ciphertext.tag', 1);
  const encrypted = await store.getPendingOutbox(10);
  assertEqual(encrypted.find((item) => item.messageId === first.id)?.ciphertext, 'v1.iv.ciphertext.tag', 'Encrypted payload must persist in the outbox');
  assertEqual(encrypted.find((item) => item.messageId === first.id)?.encryptionVersion, 1, 'Encrypted payload version must persist in the outbox');
  await store.storeOutboundCiphertext(first.id, 'v1.iv.ciphertext.tag', 1);
  await assertRejects(
    () => store.storeOutboundCiphertext(first.id, 'v1.other.ciphertext.tag', 1),
    'Changing persisted ciphertext for one message must be rejected',
  );

  await store.markAttemptFailed(first.id, new Error('network unavailable'), Date.now());
  const failed = await store.getPendingOutbox(10);
  assertEqual(failed.length, 1, 'Failed message should move outside the immediate retry window');
  assertEqual(failed[0]?.messageId, second.id, 'A failed earlier message must remain represented in durable state');
  assertEqual((await repository.getMessages()).find((message) => message.id === first.id)?.syncState, 'FAILED', 'Failed message state must persist');

  await store.markBlocked(first.id, new Error('unsupported message'));
  const afterBlocked = await store.getPendingOutbox(10);
  assertEqual(afterBlocked.length, 1, 'Blocked message must stay out of the retry queue');
  assertEqual(afterBlocked[0]?.messageId, second.id, 'Blocking an earlier message must not hide later retryable state');

  await store.reconcileOutbox(Date.now());
  const afterReconcile = await store.getPendingOutbox(10);
  assertEqual(afterReconcile.length, 1, 'Outbox reconciliation must not resurrect a blocked message');
  const blocked = await db.getFirstAsync<{ blocked: number }>('SELECT blocked FROM sync_outbox WHERE relationshipId = ? AND messageId = ?', 'the-one', first.id);
  assertEqual(blocked?.blocked, 1, 'Blocked state must be durable in SQLite');

  const stale = await repository.sendMessage({ type: 'TEXT', body: 'stale' });
  await store.reserveSenderSequence(stale.id);
  const staleCreatedAt = createdAt;
  await db.runAsync('UPDATE messages SET createdAt = ? WHERE id = ? AND relationshipId = ?', staleCreatedAt, stale.id, 'the-one');
  await db.runAsync('UPDATE sync_outbox SET createdAt = ? WHERE relationshipId = ? AND messageId = ?', staleCreatedAt, 'the-one', stale.id);
  const expiryCutoff = staleCreatedAt + 30 * 24 * 60 * 60 * 1000;
  await store.reconcileOutbox(expiryCutoff);
  assertEqual((await repository.getMessages()).some((message) => message.id === stale.id), false, 'Outbound messages older than 30 days must be deleted during reconciliation');
  assertEqual((await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_outbox WHERE relationshipId = ? AND messageId = ?', 'the-one', stale.id))?.count, 0, 'Expired outbox rows must be deleted');

  await store.markSynced(second.id);
  await assertRejects(() => store.commitInbound([
    { id: 'remote-1', type: 'TEXT', body: 'hello', createdAt, serverSeq: 1 },
    { id: 'remote-2', type: 'TEXT', body: '', createdAt: createdAt + 1, serverSeq: 2 },
  ], 2), 'Invalid inbound batches must fail before changing local state');
  assertEqual(await store.getPullCursor(), 0, 'Failed inbound validation must not advance the cursor');
  assertEqual((await repository.getMessages()).some((message) => message.id === 'remote-1'), false, 'Failed inbound validation must not insert messages');

  await assertRejects(() => store.commitInbound([{ id: 'remote-old', type: 'TEXT', body: 'too old', createdAt: Date.UTC(2019, 0, 1), serverSeq: 1 }], 1), 'Inbound timestamps outside the supported range must be rejected');
  await assertRejects(() => store.commitInbound([{ id: 'remote-future', type: 'TEXT', body: 'too future', createdAt: Date.now() + 8 * 24 * 60 * 60 * 1000, serverSeq: 1 }], 1), 'Inbound timestamps too far in the future must be rejected');
  await assertRejects(() => store.commitInbound([{ id: 'remote-emoji', type: 'EMOJI', body: '   ', createdAt, serverSeq: 1 }], 1), 'Whitespace-only emoji messages must be rejected');
  await assertRejects(() => store.commitInbound([{ id: 'remote-drawing', type: 'DRAWING', body: '', createdAt, serverSeq: 1 }], 1), 'Drawing messages without media must be rejected');
  await assertRejects(() => store.commitInbound([{ id: 'remote-cursor', type: 'TEXT', body: 'cursor mismatch', createdAt, serverSeq: 1 }], 2), 'Non-empty inbound batches must end at nextCursor');

  await store.commitInbound([
    { id: 'remote-1', type: 'TEXT', body: 'hello', createdAt, serverSeq: 1 },
    { id: 'remote-2', type: 'EMOJI', body: '♡', createdAt: createdAt + 1, serverSeq: 2 },
  ], 2, createdAt + 2_000);
  assertEqual(await store.getPullCursor(), 2, 'Successful inbound transaction must advance the cursor');
  let inbound = await repository.getMessages();
  assertEqual(inbound.find((message) => message.id === 'remote-1')?.syncState, 'SYNCED', 'Inbound messages must be marked synced');
  assertEqual(inbound.find((message) => message.id === 'remote-2')?.isActive, true, 'Newest inbound partner message must become active');

  await assertRejects(() => store.commitInbound([
    { id: 'remote-3', type: 'TEXT', body: 'must roll back', createdAt: createdAt + 2, serverSeq: 3 },
    { id: 'remote-1', type: 'TEXT', body: 'tampered', createdAt, serverSeq: 4 },
  ], 4), 'A conflict after a new inbound insert must roll back the whole transaction');
  inbound = await repository.getMessages();
  assertEqual(inbound.some((message) => message.id === 'remote-3'), false, 'Rolled-back inbound transaction must remove earlier inserts');
  assertEqual(inbound.find((message) => message.id === 'remote-1')?.body, 'hello', 'Rolled-back conflict must preserve existing data');
  assertEqual(await store.getPullCursor(), 2, 'Rolled-back inbound transaction must preserve the old cursor');

  await store.commitInbound([
    { id: 'remote-1', type: 'TEXT', body: 'hello', createdAt, serverSeq: 1 },
    { id: 'remote-2', type: 'EMOJI', body: '♡', createdAt: createdAt + 1, serverSeq: 2 },
  ], 2, createdAt + 3_000);
  assertEqual((await repository.getMessages()).filter((message) => message.id.startsWith('remote-')).length, 2, 'Replaying an already committed inbound batch must be idempotent');

  await assertRejects(() => store.commitInbound([{ id: 'remote-1', type: 'TEXT', body: 'tampered', createdAt, serverSeq: 1 }], 1), 'Inbound message identity conflicts must be rejected');
  assertEqual((await repository.getMessages()).find((message) => message.id === 'remote-1')?.body, 'hello', 'Conflicting inbound data must not overwrite local data');
  assertEqual(await store.getPullCursor(), 2, 'Pull cursor should remain unchanged after rejected inbound data');

  await assertRejects(() => store.commitInbound([{ id: 'remote-1', type: 'TEXT', body: 'hello', createdAt, serverSeq: 1 }], 1, createdAt + 4_000), 'Inbound cursor must never move backwards');

  await db.runAsync("INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState) VALUES (?, ?, 'PARTNER', 'TEXT', ?, ?, (SELECT COALESCE(MAX(orderIndex), 0) + 1 FROM messages WHERE relationshipId = ?), NULL, 'SYNCED')", 'legacy-remote', 'the-one', 'legacy replay', createdAt + 5, 'the-one');
  await store.commitInbound([{ id: 'legacy-remote', type: 'TEXT', body: 'legacy replay', createdAt: createdAt + 5, serverSeq: 3 }], 3, createdAt + 6_000);
  const legacyReceipt = await db.getFirstAsync<{ serverSeq: number }>('SELECT serverSeq FROM sync_inbox WHERE relationshipId = ? AND messageId = ?', 'the-one', 'legacy-remote');
  assertEqual(legacyReceipt?.serverSeq, 3, 'Replay of a legacy inbound message must reconstruct its durable receipt');

  await assertRejects(() => store.replaceDevice('device-b', 'ME'), 'Device replacement must reject pending outbound messages');
  await store.markSynced(first.id);
  const beforeDeviceRefresh = await store.getState();
  await store.replaceDevice('device-b', 'ME');
  const afterDeviceRefresh = await store.getState();
  assertEqual(afterDeviceRefresh.deviceId, 'device-b', 'Device replacement should persist the new device identity');
  assertEqual(afterDeviceRefresh.nextSenderSeq, 1, 'Device replacement should reset sender sequence for the new device');
  assertEqual(afterDeviceRefresh.pullCursor, beforeDeviceRefresh.pullCursor, 'Device replacement must preserve the pull cursor');

  await store.clear();
  const cleared = await store.getState();
  assertEqual(cleared.deviceId, null, 'Clearing sync state must remove device identity');
  assertEqual(cleared.pullCursor, 0, 'Clearing sync state must reset the pull cursor');
  assertEqual((await store.getPendingOutbox(10)).length, 0, 'Clearing sync state must remove the outbox');
}
