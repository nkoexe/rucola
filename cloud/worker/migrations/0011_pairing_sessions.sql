CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL UNIQUE,
  relationship_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  initiator_share TEXT NOT NULL,
  responder_share TEXT,
  handoff TEXT,
  confirmation TEXT,
  partner_credential_hash TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (invitation_id) REFERENCES invitations(id),
  FOREIGN KEY (relationship_id) REFERENCES relationships(id)
);

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_relationship
  ON pairing_sessions (relationship_id);

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires
  ON pairing_sessions (expires_at);
