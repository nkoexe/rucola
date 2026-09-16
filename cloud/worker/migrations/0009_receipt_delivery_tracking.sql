ALTER TABLE message_receipts ADD COLUMN delivered_to_device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT;
ALTER TABLE message_receipts ADD COLUMN delivered_at INTEGER;

CREATE INDEX message_receipts_delivery
  ON message_receipts(relationship_id, delivered_to_device_id, server_seq);
