PRAGMA foreign_keys = ON;

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PAIRING', 'ACTIVE', 'ENDED')),
  next_server_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_server_seq >= 1),
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  participant TEXT NOT NULL CHECK (participant IN ('ME', 'PARTNER')),
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX devices_active_participant
  ON devices(relationship_id, participant)
  WHERE revoked_at IS NULL;
CREATE INDEX devices_relationship ON devices(relationship_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  confirmation_code_hash TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_device_id TEXT,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (consumed_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL AND consumed_by_device_id IS NULL)
      OR (consumed_at IS NOT NULL AND consumed_by_device_id IS NOT NULL))
);
CREATE INDEX invitations_expiry ON invitations(expires_at);

CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('PHOTO', 'VIDEO', 'DRAWING')),
  declared_mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  checksum TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'ATTACHED', 'ABANDONED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  attached_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((status = 'PENDING' AND completed_at IS NULL AND attached_at IS NULL)
      OR (status = 'READY' AND completed_at IS NOT NULL AND attached_at IS NULL)
      OR (status = 'ATTACHED' AND completed_at IS NOT NULL AND attached_at IS NOT NULL)
      OR (status = 'ABANDONED'))
);
CREATE INDEX media_uploads_expiry ON media_uploads(expires_at);
CREATE INDEX media_uploads_relationship ON media_uploads(relationship_id, created_at);

CREATE TABLE mailbox_messages (
  relationship_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  sender_participant TEXT NOT NULL CHECK (sender_participant IN ('ME', 'PARTNER')),
  sender_seq INTEGER NOT NULL CHECK (sender_seq >= 1),
  client_created_at INTEGER NOT NULL,
  server_seq INTEGER NOT NULL CHECK (server_seq >= 1),
  server_received_at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')),
  ciphertext BLOB NOT NULL,
  encryption_version INTEGER NOT NULL,
  media_upload_id TEXT,
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (media_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT,
  PRIMARY KEY (relationship_id, message_id),
  UNIQUE (relationship_id, sender_device_id, sender_seq),
  UNIQUE (relationship_id, server_seq),
  UNIQUE (media_upload_id),
  CHECK (expires_at > server_received_at),
  CHECK ((acknowledged_at IS NULL) OR (acknowledged_at >= server_received_at))
);
CREATE INDEX mailbox_pull ON mailbox_messages(relationship_id, server_seq);
CREATE INDEX mailbox_expiry ON mailbox_messages(expires_at);
CREATE INDEX mailbox_ack_cleanup ON mailbox_messages(relationship_id, acknowledged_at);
CREATE INDEX mailbox_sender_sequence ON mailbox_messages(relationship_id, sender_device_id, sender_seq);
