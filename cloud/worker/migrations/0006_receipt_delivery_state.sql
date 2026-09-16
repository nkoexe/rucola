ALTER TABLE message_receipts ADD COLUMN delivery_expires_at INTEGER;
ALTER TABLE message_receipts ADD COLUMN retention_expires_at INTEGER;
ALTER TABLE message_receipts ADD COLUMN acknowledged_at INTEGER;

UPDATE message_receipts
SET delivery_expires_at = created_at + (14 * 24 * 60 * 60 * 1000),
    retention_expires_at = created_at + (30 * 24 * 60 * 60 * 1000)
WHERE delivery_expires_at IS NULL OR retention_expires_at IS NULL;

CREATE INDEX message_receipts_cleanup
  ON message_receipts(retention_expires_at, acknowledged_at, delivery_expires_at);
