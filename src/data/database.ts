import * as SQLite from 'expo-sqlite';

const DATABASE_NAME = 'rucola.db';
const SCHEMA_VERSION = 2;

export const RELATIONSHIP_ID = 'the-one';

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  databasePromise ??= SQLite.openDatabaseAsync(DATABASE_NAME);
  return databasePromise;
}

export async function initializeDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await getDatabase();

  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.execAsync('PRAGMA journal_mode = WAL;');

  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const version = versionRow?.user_version ?? 0;

  if (version > SCHEMA_VERSION) {
    throw new Error(`Rucola database version ${version} is newer than this app supports.`);
  }

  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relationships', 'messages', 'active_message_slots')",
  );

  if (version === 0 && tables.length === 0) {
    await createLatestSchema(db);
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    return verifyDatabase(db);
  }

  if (version === 0) {
    if (tables.length !== 3) {
      throw new Error('Rucola database is incomplete and cannot be migrated safely.');
    }
    await migrateLegacySchema(db);
  } else if (version === 1) {
    // Version 1 uses the same schema as the original unversioned database.
    await migrateLegacySchema(db);
  }

  return verifyDatabase(db);
}

async function verifyDatabase(db: SQLite.SQLiteDatabase): Promise<SQLite.SQLiteDatabase> {
  const currentVersion = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;'))?.user_version ?? 0;
  if (currentVersion !== SCHEMA_VERSION) {
    throw new Error(`Rucola database migration stopped at version ${currentVersion}.`);
  }

  const foreignKeyErrors = await db.getAllAsync('PRAGMA foreign_key_check;');
  if (foreignKeyErrors.length > 0) {
    throw new Error('Rucola database integrity check failed after migration.');
  }

  return db;
}

async function createLatestSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY NOT NULL,
      partnerNickname TEXT NOT NULL,
      ownName TEXT NOT NULL,
      partnerColor TEXT NOT NULL,
      togetherSince INTEGER
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
      type TEXT NOT NULL CHECK (type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')),
      body TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      orderIndex INTEGER NOT NULL,
      mediaReference TEXT,
      syncState TEXT NOT NULL CHECK (syncState IN ('LOCAL_ONLY', 'PENDING', 'SYNCED', 'FAILED')),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE,
      UNIQUE (relationshipId, id),
      UNIQUE (relationshipId, participant, id)
    );

    CREATE INDEX messages_relationship_order
      ON messages (relationshipId, orderIndex DESC, createdAt DESC, id DESC);

    CREATE TABLE active_message_slots (
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
      messageId TEXT NOT NULL UNIQUE,
      PRIMARY KEY (relationshipId, participant),
      FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE,
      FOREIGN KEY (relationshipId, participant, messageId)
        REFERENCES messages(relationshipId, participant, id) ON DELETE RESTRICT
    );
  `);
}

interface LegacyMessageRow {
  id: string;
  relationshipId: string;
  participant: string;
  type: string;
  body: string;
  createdAt: string | number;
  orderIndex: number;
  isActive: number;
  mediaReference: string | null;
  syncState: string;
}

interface LegacyRelationshipRow {
  id: string;
  partnerNickname: string;
  ownName: string;
  partnerColor: string;
  togetherSince: string | number | null;
}

interface LegacyActiveSlotRow {
  relationshipId: string;
  participant: string;
  messageId: string;
}

function parseLegacyInteger(value: string | number, field: string, rowId: string): number {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Cannot migrate ${field} for legacy row ${rowId}.`);
  }
  return parsed;
}

function parseLegacyNullableInteger(
  value: string | number | null,
  field: string,
  rowId: string,
): number | null {
  if (value === null) {
    return null;
  }
  return parseLegacyInteger(value, field, rowId);
}

async function migrateLegacySchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    const relationships = await db.getAllAsync<LegacyRelationshipRow>(
      'SELECT id, partnerNickname, ownName, partnerColor, togetherSince FROM relationships',
    );
    const messages = await db.getAllAsync<LegacyMessageRow>(
      'SELECT id, relationshipId, participant, type, body, createdAt, orderIndex, isActive, mediaReference, syncState FROM messages',
    );
    const activeSlots = await db.getAllAsync<LegacyActiveSlotRow>(
      'SELECT relationshipId, participant, messageId FROM active_message_slots',
    );

    const messageById = new Map(messages.map((message) => [message.id, message]));
    const slotByParticipant = new Map<string, LegacyActiveSlotRow>();

    for (const slot of activeSlots) {
      const key = `${slot.relationshipId}:${slot.participant}`;
      if (slotByParticipant.has(key)) {
        throw new Error(`Legacy database has multiple active slots for ${key}.`);
      }

      const message = messageById.get(slot.messageId);
      if (!message) {
        throw new Error(`Legacy active slot references missing message ${slot.messageId}.`);
      }
      if (message.relationshipId !== slot.relationshipId || message.participant !== slot.participant) {
        throw new Error('Legacy active slot references a message from the wrong relationship or participant.');
      }
      if (message.isActive !== 1) {
        throw new Error(`Legacy active slot ${slot.messageId} disagrees with message isActive state.`);
      }

      slotByParticipant.set(key, slot);
    }

    for (const message of messages) {
      if (message.isActive !== 0 && message.isActive !== 1) {
        throw new Error(`Legacy message ${message.id} has invalid isActive state.`);
      }
      if (message.isActive === 1) {
        const key = `${message.relationshipId}:${message.participant}`;
        const slot = slotByParticipant.get(key);
        if (!slot || slot.messageId !== message.id) {
          throw new Error(`Legacy active message ${message.id} has no matching active slot.`);
        }
      }
    }

    await db.execAsync(`
      ALTER TABLE relationships RENAME TO relationships_legacy;
      ALTER TABLE messages RENAME TO messages_legacy;
      ALTER TABLE active_message_slots RENAME TO active_message_slots_legacy;
    `);

    await createLatestSchema(db);

    for (const relationship of relationships) {
      const togetherSince = parseLegacyNullableInteger(
        relationship.togetherSince,
        'togetherSince',
        relationship.id,
      );
      await db.runAsync(
        `INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince)
         VALUES (?, ?, ?, ?, ?)`,
        relationship.id,
        relationship.partnerNickname,
        relationship.ownName,
        relationship.partnerColor,
        togetherSince,
      );
    }

    for (const message of messages) {
      const createdAt = parseLegacyInteger(message.createdAt, 'createdAt', message.id);
      await db.runAsync(
        `INSERT INTO messages
         (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.relationshipId,
        message.participant,
        message.type,
        message.body,
        createdAt,
        message.orderIndex,
        message.mediaReference,
        message.syncState,
      );
    }

    for (const slot of activeSlots) {
      await db.runAsync(
        `INSERT INTO active_message_slots (relationshipId, participant, messageId)
         VALUES (?, ?, ?)`,
        slot.relationshipId,
        slot.participant,
        slot.messageId,
      );
    }

    await db.execAsync(`
      DROP TABLE active_message_slots_legacy;
      DROP TABLE messages_legacy;
      DROP TABLE relationships_legacy;
      DROP INDEX IF EXISTS messages_relationship_participant_active;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  });
}
