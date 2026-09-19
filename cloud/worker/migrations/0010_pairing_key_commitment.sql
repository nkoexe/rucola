PRAGMA foreign_keys = ON;

ALTER TABLE relationships ADD COLUMN relationship_key_commitment TEXT;

CREATE INDEX relationships_key_commitment
  ON relationships(relationship_key_commitment);
