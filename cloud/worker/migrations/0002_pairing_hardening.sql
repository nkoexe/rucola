PRAGMA foreign_keys = ON;

ALTER TABLE invitations ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0);
ALTER TABLE invitations ADD COLUMN locked_until INTEGER;

CREATE INDEX invitations_lockout ON invitations(locked_until);
