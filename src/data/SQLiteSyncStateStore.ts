import type { SQLiteDatabase } from 'expo-sqlite';
import { RELATIONSHIP_ID } from './database';
import type { Participant, SyncState } from '../domain/models';

export interface LocalSyncState {
  relationshipId: string;
  deviceId: string | null;
  participant: Participant | null;
  nextSenderSeq: number;
  pullCursor: number;
  updatedAt: number;
}

export interface PendingSyncMessage {
  messageId: string;
  senderSeq: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  createdAt: number;
}

type SQLiteWriteContext = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync' | 'runAsync'>;

const DEFAULT_NEXT_SENDER_SEQ = 1;
const DEFAULT_PULL_CURSOR = 0;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

function mapState(row: {
  relationshipId: string;
  deviceId: string | null;
  participant: Participant | null;
  nextSenderSeq: number;
  pullCursor: number;
  updatedAt: number;
}): LocalSyncState {
  return { ...row };
}

function retryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

function normalizeError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim().slice(0, 500);
  return String(cause).trim().slice(0, 500) || 'Unknown sync error';
}

export class SQLiteSyncStateStore {
  constructor(private readonly db: SQLiteDatabase) {}

  async getState(): Promise<LocalSyncState> {
    const row = await this.db.getFirstAsync<LocalSyncState>(
      `SELECT relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt
       FROM sync_state WHERE relationshipId = ?`,
      RELATIONSHIP_ID,
    );

    if (row) return mapState(row);

    const now = Date.now();
    await this.db.runAsync(
      `INSERT INTO sync_state
         (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt)
       VALUES (?, NULL, NULL, ?, ?, ?)`,
      RELATIONSHIP_ID,
      DEFAULT_NEXT_SENDER_SEQ,
      DEFAULT_PULL_CURSOR,
      now,
    );
    return {
      relationshipId: RELATIONSHIP_ID,
      deviceId: null,
      participant: null,
      nextSenderSeq: DEFAULT_NEXT_SENDER_SEQ,
      pullCursor: DEFAULT_PULL_CURSOR,
      updatedAt: now,
    };
  }

  async setDevice(deviceId: string, participant: Participant): Promise<void> {
    const normalizedDeviceId = deviceId.trim();
    if (!normalizedDeviceId) throw new Error('A cloud device ID is required.');

    await this.withWrite(async (tx) => {
      const now = Date.now();
      await tx.runAsync(
        `INSERT INTO sync_state
           (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(relationshipId) DO UPDATE SET
           deviceId = excluded.deviceId,
           participant = excluded.participant,
           updatedAt = excluded.updatedAt`,
        RELATIONSHIP_ID,
        normalizedDeviceId,
        participant,
        DEFAULT_NEXT_SENDER_SEQ,
        DEFAULT_PULL_CURSOR,
        now,
      );
    });
  }

  async reserveSenderSequence(messageId: string, now = Date.now()): Promise<number> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) throw new Error('A message ID is required.');

    let senderSeq = 0;
    await this.withWrite(async (tx) => {
      const message = await tx.getFirstAsync<{ id: string; relationshipId: string; participant: Participant }>(
        `SELECT id, relationshipId, participant FROM messages WHERE id = ?`,
        normalizedMessageId,
      );
      if (!message || message.relationshipId !== RELATIONSHIP_ID || message.participant !== 'ME') {
        throw new Error('Only an existing local message can enter the sync outbox.');
      }

      const existing = await tx.getFirstAsync<{ senderSeq: number }>(
        `SELECT senderSeq FROM sync_outbox WHERE relationshipId = ? AND messageId = ?`,
        RELATIONSHIP_ID,
        normalizedMessageId,
      );
      if (existing) {
        senderSeq = existing.senderSeq;
        return;
      }

      const state = await tx.getFirstAsync<{ nextSenderSeq: number }>(
        `SELECT nextSenderSeq FROM sync_state WHERE relationshipId = ?`,
        RELATIONSHIP_ID,
      );
      const nextSenderSeq = state?.nextSenderSeq ?? DEFAULT_NEXT_SENDER_SEQ;
      if (!Number.isSafeInteger(nextSenderSeq) || nextSenderSeq < 1) {
        throw new Error('Local sync sender sequence is invalid.');
      }

      senderSeq = nextSenderSeq;
      await tx.runAsync(
        `INSERT INTO sync_outbox
           (relationshipId, messageId, senderSeq, attempts, lastError, nextAttemptAt, createdAt)
         VALUES (?, ?, ?, 0, NULL, ?, ?)`,
        RELATIONSHIP_ID,
        normalizedMessageId,
        senderSeq,
        now,
        now,
      );
      await tx.runAsync(
        `INSERT INTO sync_state
           (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt)
         VALUES (?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(relationshipId) DO UPDATE SET
           nextSenderSeq = excluded.nextSenderSeq,
           updatedAt = excluded.updatedAt`,
        RELATIONSHIP_ID,
        senderSeq + 1,
        DEFAULT_PULL_CURSOR,
        now,
      );
    });

    return senderSeq;
  }

  async getDueOutbox(now = Date.now(), limit = 20): Promise<PendingSyncMessage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Sync outbox limit must be between 1 and 100.');
    }

    return this.db.getAllAsync<PendingSyncMessage>(
      `SELECT messageId, senderSeq, attempts, lastError, nextAttemptAt, createdAt
       FROM sync_outbox
       WHERE relationshipId = ? AND nextAttemptAt <= ?
       ORDER BY senderSeq ASC
       LIMIT ?`,
      RELATIONSHIP_ID,
      now,
      limit,
    );
  }

  async markAttemptFailed(messageId: string, cause: unknown, now = Date.now()): Promise<void> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) throw new Error('A message ID is required.');

    await this.withWrite(async (tx) => {
      const existing = await tx.getFirstAsync<{ attempts: number }>(
        `SELECT attempts FROM sync_outbox WHERE relationshipId = ? AND messageId = ?`,
        RELATIONSHIP_ID,
        normalizedMessageId,
      );
      if (!existing) return;

      const attempts = existing.attempts + 1;
      await tx.runAsync(
        `UPDATE sync_outbox
         SET attempts = ?, lastError = ?, nextAttemptAt = ?
         WHERE relationshipId = ? AND messageId = ?`,
        attempts,
        normalizeError(cause),
        now + retryDelay(attempts),
        RELATIONSHIP_ID,
        normalizedMessageId,
      );
      await tx.runAsync(
        `UPDATE messages SET syncState = ? WHERE id = ? AND relationshipId = ?`,
        'FAILED' satisfies SyncState,
        normalizedMessageId,
        RELATIONSHIP_ID,
      );
    });
  }

  async markSynced(messageId: string): Promise<void> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) throw new Error('A message ID is required.');

    await this.withWrite(async (tx) => {
      await tx.runAsync(
        `DELETE FROM sync_outbox WHERE relationshipId = ? AND messageId = ?`,
        RELATIONSHIP_ID,
        normalizedMessageId,
      );
      await tx.runAsync(
        `UPDATE messages SET syncState = ? WHERE id = ? AND relationshipId = ?`,
        'SYNCED' satisfies SyncState,
        normalizedMessageId,
        RELATIONSHIP_ID,
      );
    });
  }

  async getPullCursor(): Promise<number> {
    const state = await this.getState();
    return state.pullCursor;
  }

  async advancePullCursor(cursor: number, now = Date.now()): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Pull cursor must be a non-negative safe integer.');

    await this.withWrite(async (tx) => {
      const state = await tx.getFirstAsync<{ pullCursor: number }>(
        `SELECT pullCursor FROM sync_state WHERE relationshipId = ?`,
        RELATIONSHIP_ID,
      );
      const current = state?.pullCursor ?? DEFAULT_PULL_CURSOR;
      if (cursor < current) throw new Error('Pull cursor cannot move backwards.');

      await tx.runAsync(
        `INSERT INTO sync_state
           (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt)
         VALUES (?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(relationshipId) DO UPDATE SET
           pullCursor = excluded.pullCursor,
           updatedAt = excluded.updatedAt`,
        RELATIONSHIP_ID,
        DEFAULT_NEXT_SENDER_SEQ,
        cursor,
        now,
      );
    });
  }

  async clear(): Promise<void> {
    await this.withWrite(async (tx) => {
      await tx.runAsync('DELETE FROM sync_outbox WHERE relationshipId = ?', RELATIONSHIP_ID);
      await tx.runAsync('DELETE FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
    });
  }

  private async withWrite(action: (tx: SQLiteWriteContext) => Promise<void>): Promise<void> {
    await this.db.withExclusiveTransactionAsync(action);
  }
}
