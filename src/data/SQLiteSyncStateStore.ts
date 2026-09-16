import type { SQLiteDatabase } from 'expo-sqlite';
import { RELATIONSHIP_ID } from './constants.ts';
import type { MessageType, Participant } from '../domain/models';

const DEFAULT_NEXT_SENDER_SEQ = 1;
const DEFAULT_PULL_CURSOR = 0;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_CREATED_AT = Date.UTC(2020, 0, 1);
const MAX_FUTURE_CREATED_AT_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 12 * 1024;
const MESSAGE_TYPES = new Set<MessageType>(['TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING']);

export interface LocalSyncState {
  relationshipId: string;
  deviceId: string | null;
  participant: Participant | null;
  nextSenderSeq: number;
  pullCursor: number;
  updatedAt: number;
}

export interface OutboxItem {
  messageId: string;
  senderSeq: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  blocked: number;
  createdAt: number;
}

export interface InboundSyncMessage {
  id: string;
  type: MessageType;
  body: string;
  createdAt: number;
  serverSeq: number;
  mediaReference?: string | null;
}

export interface DroppedInboundSyncMessage {
  messageId: string;
  serverSeq: number;
  reason: string;
}

export interface SyncStateStoreOptions {
  database: SQLiteDatabase;
  now?: () => number;
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function validateMessage(message: InboundSyncMessage, now: number): void {
  if (typeof message.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(message.id) || message.id.length === 0 || message.id.length > 128) throw new Error('Invalid inbound message ID.');
  if (!MESSAGE_TYPES.has(message.type)) throw new Error('Invalid inbound message type.');
  if (!Number.isSafeInteger(message.serverSeq) || message.serverSeq < 1) throw new Error('Invalid inbound server sequence.');
  if (!Number.isSafeInteger(message.createdAt) || message.createdAt < MIN_CREATED_AT || message.createdAt > now + MAX_FUTURE_CREATED_AT_MS) throw new Error('Invalid inbound createdAt.');
  if (typeof message.body !== 'string' || new TextEncoder().encode(message.body).byteLength > MAX_BODY_BYTES) throw new Error('Invalid inbound message body.');
  if ((message.type === 'TEXT' || message.type === 'EMOJI') && message.body.trim() === '') throw new Error('Text and emoji messages require content.');
  if ((message.type === 'PHOTO_VIDEO' || message.type === 'DRAWING') && !message.mediaReference) throw new Error('Media message requires a media reference.');
  if (message.type !== 'PHOTO_VIDEO' && message.type !== 'DRAWING' && message.mediaReference != null) throw new Error('Non-media message cannot have a media reference.');
  if (message.mediaReference != null && (!/^[A-Za-z0-9_./:-]+$/.test(message.mediaReference) || message.mediaReference.length > 1024)) throw new Error('Invalid inbound media reference.');
}

function validateDropped(message: DroppedInboundSyncMessage): void {
  if (typeof message.messageId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(message.messageId) || message.messageId.length === 0 || message.messageId.length > 128) throw new Error('Invalid dropped inbound message ID.');
  if (!Number.isSafeInteger(message.serverSeq) || message.serverSeq < 1) throw new Error('Invalid dropped inbound server sequence.');
  if (typeof message.reason !== 'string' || message.reason.length === 0 || message.reason.length > 256) throw new Error('Invalid dropped inbound reason.');
}

export class SQLiteSyncStateStore {
  private readonly database: SQLiteDatabase;
  private readonly now: () => number;

  constructor(options: SyncStateStoreOptions) {
    this.database = options.database;
    this.now = options.now ?? Date.now;
  }

  async getState(): Promise<LocalSyncState> {
    const row = await this.database.getFirstAsync<{ relationshipId: string; deviceId: string | null; participant: Participant | null; nextSenderSeq: number; pullCursor: number; updatedAt: number }>('SELECT relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt FROM sync_state WHERE relationshipId = ? LIMIT 1', RELATIONSHIP_ID);
    return row ? { relationshipId: row.relationshipId, deviceId: row.deviceId, participant: row.participant, nextSenderSeq: row.nextSenderSeq, pullCursor: row.pullCursor, updatedAt: row.updatedAt } : { relationshipId: RELATIONSHIP_ID, deviceId: null, participant: null, nextSenderSeq: DEFAULT_NEXT_SENDER_SEQ, pullCursor: DEFAULT_PULL_CURSOR, updatedAt: this.now() };
  }

  async setDevice(deviceId: string, participant: Participant): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('Device ID is invalid.');
    if (participant !== 'ME' && participant !== 'PARTNER') throw new Error('Invalid participant.');
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      const current = await transaction.getFirstAsync<{ deviceId: string | null; participant: Participant | null }>('SELECT deviceId, participant FROM sync_state WHERE relationshipId = ? LIMIT 1', RELATIONSHIP_ID);
      if (current?.deviceId && current.deviceId !== deviceId) throw new Error('Cannot replace an active sync device through setDevice. Use replaceDevice after resolving pending outbound messages.');
      if (current?.deviceId === deviceId && current.participant && current.participant !== participant) throw new Error('Cannot change the participant role of an active sync device.');
      await transaction.runAsync('INSERT INTO sync_state (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(relationshipId) DO UPDATE SET deviceId = excluded.deviceId, participant = excluded.participant, updatedAt = excluded.updatedAt', RELATIONSHIP_ID, deviceId, participant, DEFAULT_NEXT_SENDER_SEQ, DEFAULT_PULL_CURSOR, this.now());
    });
  }

  async replaceDevice(deviceId: string, participant: Participant): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('Device ID is invalid.');
    if (participant !== 'ME' && participant !== 'PARTNER') throw new Error('Invalid participant.');
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      const pending = await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_outbox WHERE relationshipId = ? AND blocked = 0', RELATIONSHIP_ID);
      if ((pending?.count ?? 0) !== 0) throw new Error('Cannot replace sync device while outbound messages are pending.');
      const current = await transaction.getFirstAsync<{ pullCursor: number }>('SELECT pullCursor FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
      const pullCursor = current?.pullCursor ?? DEFAULT_PULL_CURSOR;
      await transaction.runAsync('INSERT INTO sync_state (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(relationshipId) DO UPDATE SET deviceId = excluded.deviceId, participant = excluded.participant, nextSenderSeq = excluded.nextSenderSeq, pullCursor = excluded.pullCursor, updatedAt = excluded.updatedAt', RELATIONSHIP_ID, deviceId, participant, DEFAULT_NEXT_SENDER_SEQ, pullCursor, this.now());
    });
  }

  async reserveSenderSequence(messageId: string): Promise<number> {
    if (!/^[A-Za-z0-9_-]+$/.test(messageId) || messageId.length === 0 || messageId.length > 128) throw new Error('Invalid message ID.');
    let reserved = DEFAULT_NEXT_SENDER_SEQ;
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      const existing = await transaction.getFirstAsync<{ senderSeq: number }>('SELECT senderSeq FROM sync_outbox WHERE relationshipId = ? AND messageId = ?', RELATIONSHIP_ID, messageId);
      if (existing) { reserved = existing.senderSeq; return; }
      const state = await transaction.getFirstAsync<{ nextSenderSeq: number }>('SELECT nextSenderSeq FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
      const next = state?.nextSenderSeq ?? DEFAULT_NEXT_SENDER_SEQ;
      await transaction.runAsync('INSERT INTO sync_state (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt) VALUES (?, NULL, NULL, ?, ?, ?) ON CONFLICT(relationshipId) DO NOTHING', RELATIONSHIP_ID, next + 1, DEFAULT_PULL_CURSOR, this.now());
      await transaction.runAsync('INSERT INTO sync_outbox (relationshipId, messageId, senderSeq, attempts, lastError, nextAttemptAt, blocked, createdAt) VALUES (?, ?, ?, 0, NULL, ?, 0, ?)', RELATIONSHIP_ID, messageId, next, this.now(), this.now());
      await transaction.runAsync('UPDATE sync_state SET nextSenderSeq = ?, updatedAt = ? WHERE relationshipId = ?', next + 1, this.now(), RELATIONSHIP_ID);
      reserved = next;
    });
    return reserved;
  }

  async getDueOutbox(now: number, limit: number): Promise<OutboxItem[]> {
    return this.database.getAllAsync<OutboxItem>('SELECT messageId, senderSeq, attempts, lastError, nextAttemptAt, blocked, createdAt FROM sync_outbox WHERE relationshipId = ? AND blocked = 0 AND nextAttemptAt <= ? ORDER BY senderSeq ASC LIMIT ?', RELATIONSHIP_ID, now, limit);
  }

  async getPendingOutbox(limit: number): Promise<OutboxItem[]> { return this.getDueOutbox(Number.MAX_SAFE_INTEGER, limit); }

  async markAttemptFailed(messageId: string, cause: unknown, now: number): Promise<void> {
    const error = cause instanceof Error ? cause.message : String(cause);
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<{ attempts: number }>('SELECT attempts FROM sync_outbox WHERE relationshipId = ? AND messageId = ? AND blocked = 0', RELATIONSHIP_ID, messageId);
      if (!row) return;
      const attempts = row.attempts + 1;
      await transaction.runAsync('UPDATE sync_outbox SET attempts = ?, lastError = ?, nextAttemptAt = ? WHERE relationshipId = ? AND messageId = ? AND blocked = 0', attempts, error, now + retryDelay(attempts), RELATIONSHIP_ID, messageId);
      await transaction.runAsync('UPDATE messages SET syncState = ? WHERE id = ? AND relationshipId = ?', 'FAILED', messageId, RELATIONSHIP_ID);
    });
  }

  async markBlocked(messageId: string, cause: unknown): Promise<void> {
    const error = cause instanceof Error ? cause.message : String(cause);
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('UPDATE sync_outbox SET lastError = ?, nextAttemptAt = ?, blocked = 1 WHERE relationshipId = ? AND messageId = ?', error, Number.MAX_SAFE_INTEGER, RELATIONSHIP_ID, messageId);
      await transaction.runAsync('UPDATE messages SET syncState = ? WHERE id = ? AND relationshipId = ?', 'FAILED', messageId, RELATIONSHIP_ID);
    });
  }

  async markSynced(messageId: string): Promise<void> {
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('DELETE FROM sync_outbox WHERE relationshipId = ? AND messageId = ?', RELATIONSHIP_ID, messageId);
      await transaction.runAsync('UPDATE messages SET syncState = ? WHERE id = ? AND relationshipId = ?', 'SYNCED', messageId, RELATIONSHIP_ID);
    });
  }

  async getPullCursor(): Promise<number> {
    const row = await this.database.getFirstAsync<{ pullCursor: number }>('SELECT pullCursor FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
    return row?.pullCursor ?? DEFAULT_PULL_CURSOR;
  }

  async commitInbound(messages: InboundSyncMessage[], nextCursor: number, now = this.now(), dropped: DroppedInboundSyncMessage[] = []): Promise<void> {
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) throw new Error('Invalid inbound cursor.');
    const serverSequences = new Set<number>();
    let previousServerSeq = 0;
    for (const message of messages) {
      validateMessage(message, now);
      if (serverSequences.has(message.serverSeq) || message.serverSeq <= previousServerSeq) throw new Error('Inbound server sequences must be strictly increasing and unique.');
      serverSequences.add(message.serverSeq);
      previousServerSeq = message.serverSeq;
    }
    const droppedSequences = new Set<number>();
    for (const message of dropped) {
      validateDropped(message);
      if (droppedSequences.has(message.serverSeq) || serverSequences.has(message.serverSeq)) throw new Error('Dropped inbound server sequences must be unique and disjoint from accepted messages.');
      droppedSequences.add(message.serverSeq);
    }
    if (messages.length > 0 && messages[messages.length - 1]!.serverSeq > nextCursor) throw new Error('Inbound cursor must not precede the newest message server sequence.');
    if (dropped.some((message) => message.serverSeq > nextCursor)) throw new Error('Dropped inbound server sequence exceeds inbound cursor.');

    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      const current = await transaction.getFirstAsync<{ pullCursor: number }>('SELECT pullCursor FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
      if (nextCursor < (current?.pullCursor ?? DEFAULT_PULL_CURSOR)) throw new Error('Inbound cursor moved backwards.');
      const relationship = await transaction.getFirstAsync<{ id: string }>('SELECT id FROM relationships WHERE id = ?', RELATIONSHIP_ID);
      if (!relationship) throw new Error('Relationship does not exist.');

      let newestPartner: InboundSyncMessage | null = null;
      for (const message of messages) {
        const existing = await transaction.getFirstAsync<{ id: string; participant: Participant; type: MessageType; body: string; createdAt: number; mediaReference: string | null }>('SELECT id, participant, type, body, createdAt, mediaReference FROM messages WHERE id = ? AND relationshipId = ?', message.id, RELATIONSHIP_ID);
        const receipt = await transaction.getFirstAsync<{ serverSeq: number }>('SELECT serverSeq FROM sync_inbox WHERE relationshipId = ? AND messageId = ?', RELATIONSHIP_ID, message.id);
        if (existing || receipt) {
          if (receipt) {
            if (!existing || existing.participant !== 'PARTNER' || existing.type !== message.type || existing.body !== message.body || existing.createdAt !== message.createdAt || existing.mediaReference !== (message.mediaReference ?? null) || receipt.serverSeq !== message.serverSeq) throw new Error('Inbound message ID conflicts with existing local data.');
          } else {
            if (!existing || existing.participant !== 'PARTNER' || existing.type !== message.type || existing.body !== message.body || existing.createdAt !== message.createdAt || existing.mediaReference !== (message.mediaReference ?? null)) throw new Error('Inbound message ID conflicts with existing local data.');
            await transaction.runAsync('INSERT INTO sync_inbox (relationshipId, messageId, serverSeq) VALUES (?, ?, ?)', RELATIONSHIP_ID, message.id, message.serverSeq);
          }
        } else {
          await transaction.runAsync('INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(orderIndex), 0) + 1 FROM messages WHERE relationshipId = ?), ?, ?)', message.id, RELATIONSHIP_ID, 'PARTNER', message.type, message.body, message.createdAt, RELATIONSHIP_ID, message.mediaReference ?? null, 'SYNCED');
          await transaction.runAsync('INSERT INTO sync_inbox (relationshipId, messageId, serverSeq) VALUES (?, ?, ?)', RELATIONSHIP_ID, message.id, message.serverSeq);
        }
        if (!newestPartner || message.serverSeq > newestPartner.serverSeq) newestPartner = message;
      }

      if (newestPartner) {
        const currentActive = await transaction.getFirstAsync<{ messageId: string }>('SELECT messageId FROM active_message_slots WHERE relationshipId = ? AND participant = ?', RELATIONSHIP_ID, 'PARTNER');
        if (!currentActive) {
          await transaction.runAsync('INSERT INTO active_message_slots (relationshipId, participant, messageId) VALUES (?, ?, ?)', RELATIONSHIP_ID, 'PARTNER', newestPartner.id);
        } else {
          const currentReceipt = await transaction.getFirstAsync<{ serverSeq: number }>('SELECT serverSeq FROM sync_inbox WHERE relationshipId = ? AND messageId = ?', RELATIONSHIP_ID, currentActive.messageId);
          if (!currentReceipt || currentReceipt.serverSeq < newestPartner.serverSeq) await transaction.runAsync('UPDATE active_message_slots SET messageId = ? WHERE relationshipId = ? AND participant = ?', newestPartner.id, RELATIONSHIP_ID, 'PARTNER');
        }
      }

      await transaction.runAsync('INSERT INTO sync_state (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt) VALUES (?, NULL, NULL, ?, ?, ?) ON CONFLICT(relationshipId) DO UPDATE SET pullCursor = excluded.pullCursor, updatedAt = excluded.updatedAt', RELATIONSHIP_ID, DEFAULT_NEXT_SENDER_SEQ, nextCursor, now);
    });
  }

  async reconcileOutbox(now = this.now()): Promise<number> {
    let created = 0;
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      const cutoff = now - OUTBOX_RETENTION_MS;
      const expired = await transaction.getAllAsync<{ messageId: string }>('SELECT messageId FROM sync_outbox WHERE relationshipId = ? AND createdAt <= ?', RELATIONSHIP_ID, cutoff);
      for (const item of expired) {
        await transaction.runAsync('DELETE FROM active_message_slots WHERE relationshipId = ? AND participant = ? AND messageId = ?', RELATIONSHIP_ID, 'ME', item.messageId);
        await transaction.runAsync('DELETE FROM sync_outbox WHERE relationshipId = ? AND messageId = ? AND createdAt <= ?', RELATIONSHIP_ID, item.messageId, cutoff);
        await transaction.runAsync("DELETE FROM messages WHERE relationshipId = ? AND id = ? AND participant = 'ME' AND syncState != 'SYNCED'", RELATIONSHIP_ID, item.messageId);
      }

      const existing = await transaction.getAllAsync<{ id: string; createdAt: number; participant: Participant; syncState: string }>(
        `SELECT id, createdAt, participant, syncState FROM messages WHERE relationshipId = ? AND participant = ? AND syncState IN ('LOCAL_ONLY', 'PENDING')`,
        RELATIONSHIP_ID, 'ME',
      );
      for (const message of existing) {
        if (message.createdAt <= cutoff) {
          await transaction.runAsync('DELETE FROM active_message_slots WHERE relationshipId = ? AND participant = ? AND messageId = ?', RELATIONSHIP_ID, 'ME', message.id);
          await transaction.runAsync("DELETE FROM messages WHERE relationshipId = ? AND id = ? AND participant = 'ME' AND syncState != 'SYNCED'", RELATIONSHIP_ID, message.id);
          continue;
        }
        const outbox = await transaction.getFirstAsync<{ messageId: string }>('SELECT messageId FROM sync_outbox WHERE relationshipId = ? AND messageId = ?', RELATIONSHIP_ID, message.id);
        if (outbox) continue;
        const state = await transaction.getFirstAsync<{ nextSenderSeq: number }>('SELECT nextSenderSeq FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
        const next = state?.nextSenderSeq ?? DEFAULT_NEXT_SENDER_SEQ;
        await transaction.runAsync('INSERT INTO sync_state (relationshipId, deviceId, participant, nextSenderSeq, pullCursor, updatedAt) VALUES (?, NULL, NULL, ?, ?, ?) ON CONFLICT(relationshipId) DO NOTHING', RELATIONSHIP_ID, next + 1, DEFAULT_PULL_CURSOR, now);
        await transaction.runAsync('INSERT INTO sync_outbox (relationshipId, messageId, senderSeq, attempts, lastError, nextAttemptAt, blocked, createdAt) VALUES (?, ?, ?, 0, NULL, ?, 0, ?)', RELATIONSHIP_ID, message.id, next, now, message.createdAt);
        await transaction.runAsync('UPDATE sync_state SET nextSenderSeq = ?, updatedAt = ? WHERE relationshipId = ?', next + 1, now, RELATIONSHIP_ID);
        created += 1;
      }
    });
    return created;
  }

  async clear(): Promise<void> {
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('DELETE FROM active_message_slots WHERE relationshipId = ?', RELATIONSHIP_ID);
      await transaction.runAsync('DELETE FROM sync_outbox WHERE relationshipId = ?', RELATIONSHIP_ID);
      await transaction.runAsync('DELETE FROM sync_inbox WHERE relationshipId = ?', RELATIONSHIP_ID);
      await transaction.runAsync('DELETE FROM sync_state WHERE relationshipId = ?', RELATIONSHIP_ID);
    });
  }
}
