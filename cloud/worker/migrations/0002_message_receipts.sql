CREATE TABLE message_receipts (
  relationship_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  sender_seq INTEGER NOT NULL CHECK (sender_seq >= 1),
  type TEXT NOT NULL CHECK (type IN ('TEXT', 'EMOJI', 'PHOTO_VIDEO', 'DRAWING')),
  ciphertext_hash TEXT NOT NULL,
  encryption_version INTEGER NOT NULL,
  client_created_at INTEGER NOT NULL,
  media_upload_id TEXT,
  server_seq INTEGER NOT NULL CHECK (server_seq >= 1),
  server_received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (relationship_id, message_id),
  UNIQUE (relationship_id, sender_device_id, sender_seq),
  UNIQUE (relationship_id, server_seq),
  FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (media_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT
);

CREATE INDEX message_receipts_relationship ON message_receipts(relationship_id, server_seq);
CREATE INDEX message_receipts_sender_sequence ON message_receipts(relationship_id, sender_device_id, sender_seq);
