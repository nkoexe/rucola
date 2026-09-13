export const DATABASE_NAME = 'rucola.db';
export const DATABASE_VERSION = 1;

export const CREATE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY NOT NULL,
    partnerNickname TEXT NOT NULL,
    ownName TEXT NOT NULL,
    partnerColor TEXT NOT NULL,
    togetherSince TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    relationshipId TEXT NOT NULL,
    participant TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    orderIndex INTEGER NOT NULL,
    isActive INTEGER NOT NULL DEFAULT 0,
    mediaReference TEXT,
    syncState TEXT NOT NULL,
    FOREIGN KEY (relationshipId) REFERENCES relationships(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS active_message_slots (
    relationshipId TEXT NOT NULL,
    participant TEXT NOT NULL,
    messageId TEXT NOT NULL UNIQUE,
    PRIMARY KEY (relationshipId, participant),
    FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_relationship_order
    ON messages (relationshipId, orderIndex DESC, createdAt DESC)`,
  `CREATE INDEX IF NOT EXISTS messages_relationship_participant_active
    ON messages (relationshipId, participant, isActive)`,
];
