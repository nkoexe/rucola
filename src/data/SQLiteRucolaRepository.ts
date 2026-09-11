import { randomUUID } from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { RELATIONSHIP_ID } from './database';
import { deleteOwnedMedia } from './media';
import type { Message, MessageType, Participant, Relationship, SyncState } from '../domain/models';
import type { RucolaRepository } from '../domain/repository';

interface RelationshipRow { id: string; partnerNickname: string; ownName: string; partnerColor: string; togetherSince: number | null; }
interface MessageRow { id: string; relationshipId: string; participant: Participant; type: MessageType; body: string; createdAt: number; orderIndex: number; isActive: number; mediaReference: string | null; syncState: SyncState; }
type SQLiteWriteContext = Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>;

function mapRelationship(row: RelationshipRow): Relationship { return { ...row }; }
function mapMessage(row: MessageRow): Message { return { ...row, isActive: row.isActive === 1 }; }

export class SQLiteRucolaRepository implements RucolaRepository {
  constructor(private readonly db: SQLiteDatabase) {}

  async getRelationship(): Promise<Relationship | null> {
    const row = await this.db.getFirstAsync<RelationshipRow>('SELECT id, partnerNickname, ownName, partnerColor, togetherSince FROM relationships WHERE id = ?', RELATIONSHIP_ID);
    return row ? mapRelationship(row) : null;
  }

  async saveSetup(input: { partnerNickname: string; ownName: string; partnerColor?: string; togetherSince: number | null }): Promise<void> {
    const partnerNickname = input.partnerNickname.trim();
    const ownName = input.ownName.trim();
    if (!partnerNickname || !ownName) throw new Error('Both names are required.');

    await this.db.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync(
        `INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           partnerNickname = excluded.partnerNickname,
           ownName = excluded.ownName,
           partnerColor = excluded.partnerColor,
           togetherSince = excluded.togetherSince`,
        RELATIONSHIP_ID, partnerNickname, ownName, input.partnerColor ?? '#8FC56A', input.togetherSince,
      );

      const activePartner = await tx.getFirstAsync<{ messageId: string }>(
        `SELECT messageId
         FROM active_message_slots
         WHERE relationshipId = ? AND participant = 'PARTNER'`,
        RELATIONSHIP_ID,
      );
      if (activePartner) return;

      const existingPartner = await tx.getFirstAsync<{ id: string }>(
        `SELECT id
         FROM messages
         WHERE relationshipId = ? AND participant = 'PARTNER'
         ORDER BY orderIndex DESC, createdAt DESC, id DESC
         LIMIT 1`,
        RELATIONSHIP_ID,
      );
      if (existingPartner) {
        await this.setActiveSlot(tx, 'PARTNER', existingPartner.id);
        return;
      }

      const next = await tx.getFirstAsync<{ nextOrderIndex: number }>(
        'SELECT COALESCE(MAX(orderIndex), 0) + 1 AS nextOrderIndex FROM messages WHERE relationshipId = ?',
        RELATIONSHIP_ID,
      );
      const seedMessageId = randomUUID();
      await this.insertMessage(tx, {
        id: seedMessageId,
        relationshipId: RELATIONSHIP_ID,
        participant: 'PARTNER',
        type: 'TEXT',
        body: 'good luck today ♡',
        createdAt: Date.now(),
        orderIndex: next?.nextOrderIndex ?? 1,
        mediaReference: null,
        syncState: 'LOCAL_ONLY',
        isActive: true,
      });
      await this.setActiveSlot(tx, 'PARTNER', seedMessageId);
    });
  }

  async deleteRelationship(): Promise<void> {
    let mediaReferences: string[] = [];

    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<{ mediaReference: string | null }>(
        'SELECT mediaReference FROM messages WHERE relationshipId = ? AND mediaReference IS NOT NULL',
        RELATIONSHIP_ID,
      );
      mediaReferences = rows.flatMap((row) => row.mediaReference ? [row.mediaReference] : []);

      await tx.runAsync('DELETE FROM active_message_slots WHERE relationshipId = ?', RELATIONSHIP_ID);
      await tx.runAsync('DELETE FROM messages WHERE relationshipId = ?', RELATIONSHIP_ID);
      await tx.runAsync('DELETE FROM relationships WHERE id = ?', RELATIONSHIP_ID);
    });

    await Promise.all(mediaReferences.map((mediaReference) => deleteOwnedMedia(mediaReference)));
  }

  async getMessages(): Promise<Message[]> {
    const rows = await this.db.getAllAsync<MessageRow>(
      `SELECT m.id, m.relationshipId, m.participant, m.type, m.body, m.createdAt,
              m.orderIndex, CASE WHEN s.messageId IS NULL THEN 0 ELSE 1 END AS isActive,
              m.mediaReference, m.syncState
       FROM messages m
       LEFT JOIN active_message_slots s ON s.relationshipId = m.relationshipId AND s.messageId = m.id
       WHERE m.relationshipId = ?
       ORDER BY m.orderIndex DESC, m.createdAt DESC, m.id DESC`,
      RELATIONSHIP_ID,
    );
    return rows.map(mapMessage);
  }

  async getActiveMessage(participant: Participant): Promise<Message | null> {
    const row = await this.db.getFirstAsync<MessageRow>(
      `SELECT m.id, m.relationshipId, m.participant, m.type, m.body, m.createdAt,
              m.orderIndex, 1 AS isActive, m.mediaReference, m.syncState
       FROM messages m
       INNER JOIN active_message_slots s ON s.relationshipId = m.relationshipId AND s.messageId = m.id
       WHERE s.relationshipId = ? AND s.participant = ? AND m.participant = s.participant`,
      RELATIONSHIP_ID, participant,
    );
    return row ? mapMessage(row) : null;
  }

  async sendMessage(input: { type: MessageType; body: string; mediaReference?: string | null }): Promise<Message> {
    const body = input.body.trim();
    const mediaReference = input.mediaReference?.trim() || null;

    if ((input.type === 'TEXT' || input.type === 'EMOJI') && !body) throw new Error('This message type requires content.');
    if ((input.type === 'PHOTO_VIDEO' || input.type === 'DRAWING') && !mediaReference) throw new Error('This message type requires media.');

    const message: Message = { id: randomUUID(), relationshipId: RELATIONSHIP_ID, participant: 'ME', type: input.type, body, createdAt: Date.now(), orderIndex: 0, isActive: true, mediaReference, syncState: 'PENDING' };
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const relationship = await tx.getFirstAsync<RelationshipRow>(
        'SELECT id, partnerNickname, ownName, partnerColor, togetherSince FROM relationships WHERE id = ?',
        RELATIONSHIP_ID,
      );
      if (!relationship) throw new Error('Cannot send a message before setup is complete.');

      const next = await tx.getFirstAsync<{ nextOrderIndex: number }>('SELECT COALESCE(MAX(orderIndex), 0) + 1 AS nextOrderIndex FROM messages WHERE relationshipId = ?', RELATIONSHIP_ID);
      message.orderIndex = next?.nextOrderIndex ?? 1;
      await this.insertMessage(tx, message);
      await this.setActiveSlot(tx, 'ME', message.id);
    });
    return message;
  }

  private async insertMessage(db: SQLiteWriteContext, message: Message): Promise<void> {
    await db.runAsync(
      `INSERT INTO messages (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id, message.relationshipId, message.participant, message.type, message.body, message.createdAt, message.orderIndex, message.mediaReference, message.syncState,
    );
  }

  private async setActiveSlot(db: SQLiteWriteContext, participant: Participant, messageId: string): Promise<void> {
    await db.runAsync(
      `INSERT INTO active_message_slots (relationshipId, participant, messageId)
       VALUES (?, ?, ?)
       ON CONFLICT(relationshipId, participant) DO UPDATE SET messageId = excluded.messageId`,
      RELATIONSHIP_ID, participant, messageId,
    );
  }
}
