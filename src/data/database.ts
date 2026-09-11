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
    return db;
  }

  if (version === 0) {
    await migrateLegacySchema(db);
  }

  const currentVersion = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;'))?.user_version ?? 0;
  if (currentVersion < SCHEMA_VERSION) {
    throw new Error(`Rucola database migration stopped at version ${currentVersion}.`);
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

async function migrateLegacySchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      ALTER TABLE relationships RENAME TO relationships_legacy;
      ALTER TABLE messages RENAME TO messages_legacy;
      ALTER TABLE active_message_slots RENAME TO active_message_slots_legacy;
    `);

    await createLatestSchema(db);

    await db.runAsync(
      `INSERT INTO relationships (id, partnerNickname, ownName, partnerColor, togetherSince)
       SELECT id, partnerNickname, ownName, partnerColor, togetherSince FROM relationships_legacy`,
    );

    await db.runAsync(
      `INSERT OR IGNORE INTO messages
       (id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState)
       SELECT id, relationshipId, participant, type, body, createdAt, orderIndex, mediaReference, syncState
       FROM messages_legacy
       WHERE participant IN ('ME', 'PARTNER')
         AND type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')
         AND syncState IN ('LOCAL_ONLY', 'PENDING', 'SYNCED', 'FAILED')
         AND EXISTS (SELECT 1 FROM relationships r WHERE r.id = messages_legacy.relationshipId)`,
    );

    await db.runAsync(
      `INSERT OR IGNORE INTO active_message_slots (relationshipId, participant, messageId)
       SELECT s.relationshipId, s.participant, s.messageId
       FROM active_message_slots_legacy s
       WHERE s.participant IN ('ME', 'PARTNER')
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.relationshipId = s.relationshipId
             AND m.participant = s.participant
             AND m.id = s.messageId
         )`,
    );

    await db.execAsync(`
      DROP TABLE active_message_slots_legacy;
      DROP TABLE messages_legacy;
      DROP TABLE relationships_legacy;
      DROP INDEX IF EXISTS messages_relationship_participant_active;
    `);

    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  });
}
