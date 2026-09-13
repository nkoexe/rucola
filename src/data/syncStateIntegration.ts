import type * as SQLite from 'expo-sqlite';
import { SQLiteRucolaRepository } from './SQLiteRucolaRepository';
import { SQLiteSyncStateStore } from './SQLiteSyncStateStore';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

export async function runSyncStateIntegrationTests(db: SQLite.SQLiteDatabase): Promise<void> {
  const repository = new SQLiteRucolaRepository(db);
  const store = new SQLiteSyncStateStore(db);
  await repository.saveSetup({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: null });

  const initial = await store.getState();
  assertEqual(initial.nextSenderSeq, 1, 'Fresh sync state should start sender sequences at one');
  assertEqual(initial.pullCursor, 0, 'Fresh sync state should start the pull cursor at zero');

  await store.setDevice('device-a', 'ME');
  const configured = await store.getState();
  assertEqual(configured.deviceId, 'device-a', 'Device identity should persist locally');
  assertEqual(configured.participant, 'ME', 'Participant role should persist locally');

  const first = await repository.sendMessage({ type: 'TEXT', body: 'first' });
  const second = await repository.sendMessage({ type: 'TEXT', body: 'second' });

  const [firstSeqA, firstSeqB] = await Promise.all([
    store.reserveSenderSequence(first.id),
    store.reserveSenderSequence(first.id),
  ]);
  assertEqual(firstSeqA, 1, 'First message should receive sender sequence one');
  assertEqual(firstSeqB, 1, 'Concurrent reservation of one message must be idempotent');

  const secondSeq = await store.reserveSenderSequence(second.id);
  assertEqual(secondSeq, 2, 'Second message should receive sender sequence two');

  const outbox = await store.getDueOutbox(Date.now(), 10);
  assertEqual(outbox.length, 2, 'Both reserved messages should be visible in the durable outbox');
  assertEqual(outbox[0]?.senderSeq, 1, 'Outbox must preserve sender ordering');
  assertEqual(outbox[1]?.senderSeq, 2, 'Outbox must preserve sender ordering');

  await store.markAttemptFailed(first.id, new Error('network unavailable'), Date.now());
  const failed = await store.getDueOutbox(Date.now(), 10);
  assertEqual(failed.length, 1, 'Failed message should move outside the immediate retry window');
  assertEqual(failed[0]?.messageId, second.id, 'A failed earlier message must not hide later due work');
  assertEqual((await repository.getMessages()).find((message) => message.id === first.id)?.syncState, 'FAILED', 'Failed message state must persist');

  await store.markSynced(second.id);
  assertEqual((await repository.getMessages()).find((message) => message.id === second.id)?.syncState, 'SYNCED', 'Synced message state must persist');

  const cursorBefore = await store.getPullCursor();
  await store.advancePullCursor(41);
  assertEqual(await store.getPullCursor(), 41, 'Pull cursor should advance durably');
  assertEqual(cursorBefore, 0, 'Initial pull cursor should remain zero before advancement');

  await store.advancePullCursor(41);
  await assertRejects(() => store.advancePullCursor(40), 'Pull cursor must never move backwards');

  const beforeDeviceRefresh = await store.getState();
  await store.setDevice('device-a', 'ME');
  const afterDeviceRefresh = await store.getState();
  assertEqual(afterDeviceRefresh.nextSenderSeq, beforeDeviceRefresh.nextSenderSeq, 'Refreshing device identity must not reset sender sequence');
  assertEqual(afterDeviceRefresh.pullCursor, beforeDeviceRefresh.pullCursor, 'Refreshing device identity must not reset pull cursor');

  await store.clear();
  const cleared = await store.getState();
  assertEqual(cleared.deviceId, null, 'Clearing sync state must remove device identity');
  assertEqual(cleared.pullCursor, 0, 'Clearing sync state must reset the pull cursor');
  assertEqual((await store.getDueOutbox(Date.now(), 10)).length, 0, 'Clearing sync state must remove the outbox');
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}
