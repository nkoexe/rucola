ALTER TABLE message_receipts ADD COLUMN delivered_to_device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT;
ALTER TABLE message_receipts ADD COLUMN delivered_at INTEGER;

CREATE INDEX message_receipts_delivery
  ON message_receipts(relationship_id, delivered_to_device_id, server_seq);

CREATE TRIGGER message_receipt_delivery_invariant
BEFORE UPDATE OF delivered_to_device_id, delivered_at ON message_receipts
BEGIN
  SELECT CASE
    WHEN (NEW.delivered_to_device_id IS NULL) <> (NEW.delivered_at IS NULL) THEN
      RAISE(ABORT, 'message receipt delivery fields must be set together')
  END;

  SELECT CASE
    WHEN NEW.delivered_to_device_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM devices
        WHERE id = NEW.delivered_to_device_id
          AND relationship_id = NEW.relationship_id
          AND revoked_at IS NULL
          AND id <> NEW.sender_device_id
      ) THEN
      RAISE(ABORT, 'message receipt delivery device is invalid')
  END;
END;
