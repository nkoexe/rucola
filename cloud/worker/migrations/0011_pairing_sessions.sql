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

CREATE TRIGGER pairing_session_completion_invariant
AFTER INSERT ON devices
WHEN NEW.participant = 'PARTNER'
  AND EXISTS (
    SELECT 1
    FROM pairing_sessions ps
    WHERE ps.relationship_id = NEW.relationship_id
      AND ps.partner_credential_hash = NEW.credential_hash
      AND ps.completed_at IS NULL
  )
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM pairing_sessions ps
      JOIN invitations i ON i.id = ps.invitation_id
      JOIN relationships r ON r.id = ps.relationship_id
      WHERE ps.relationship_id = NEW.relationship_id
        AND ps.partner_credential_hash = NEW.credential_hash
        AND ps.completed_at IS NULL
        AND ps.expires_at > NEW.created_at
        AND i.consumed_at IS NULL
        AND i.expires_at > NEW.created_at
        AND r.status = 'PAIRING'
    ) THEN RAISE(ABORT, 'pairing session completion invariant violated')
  END;

  UPDATE invitations
     SET consumed_at = NEW.created_at,
         consumed_by_device_id = NEW.id
   WHERE id = (
     SELECT invitation_id
     FROM pairing_sessions
     WHERE relationship_id = NEW.relationship_id
       AND partner_credential_hash = NEW.credential_hash
       AND completed_at IS NULL
     LIMIT 1
   )
     AND consumed_at IS NULL
     AND expires_at > NEW.created_at;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM invitations
      WHERE id = (
        SELECT invitation_id FROM pairing_sessions
        WHERE relationship_id = NEW.relationship_id
          AND partner_credential_hash = NEW.credential_hash
          AND completed_at IS NULL
        LIMIT 1
      )
      AND consumed_at = NEW.created_at
      AND consumed_by_device_id = NEW.id
    ) THEN RAISE(ABORT, 'pairing invitation consumption invariant violated')
  END;

  UPDATE relationships
     SET status = 'ACTIVE'
   WHERE id = NEW.relationship_id
     AND status = 'PAIRING';

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM relationships
      WHERE id = NEW.relationship_id AND status = 'ACTIVE'
    ) THEN RAISE(ABORT, 'pairing relationship activation invariant violated')
  END;

  UPDATE pairing_sessions
     SET completed_at = NEW.created_at
   WHERE relationship_id = NEW.relationship_id
     AND partner_credential_hash = NEW.credential_hash
     AND completed_at IS NULL;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM pairing_sessions
      WHERE relationship_id = NEW.relationship_id
        AND partner_credential_hash = NEW.credential_hash
        AND completed_at = NEW.created_at
    ) THEN RAISE(ABORT, 'pairing session completion invariant violated')
  END;
END;

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_credential
  ON pairing_sessions (partner_credential_hash);

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_invitation
  ON pairing_sessions (invitation_id);
