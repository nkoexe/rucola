import * as SQLite from 'expo-sqlite';

const DATABASE_NAME = 'rucola.db';

export const RELATIONSHIP_ID = 'the-one';

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  databasePromise ??= SQLite.openDatabaseAsync(DATABASE_NAME);
  return databasePromise;
}

export async function initializeDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await getDatabase();

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY NOT NULL,
      partnerNickname TEXT NOT NULL,
      ownName TEXT NOT NULL,
      partnerColor TEXT NOT NULL,
      togetherSince INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      orderIndex INTEGER NOT NULL,
      isActive INTEGER NOT NULL DEFAULT 0,
      mediaReference TEXT,
      syncState TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_relationship_participant_active
      ON messages (relationshipId, participant, isActive);

    CREATE TABLE IF NOT EXISTS active_message_slots (
      relationshipId TEXT NOT NULL,
      participant TEXT NOT NULL,
      messageId TEXT NOT NULL UNIQUE,
      PRIMARY KEY (relationshipId, participant),
      FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE RESTRICT
    );
  `);

  return db;
}
