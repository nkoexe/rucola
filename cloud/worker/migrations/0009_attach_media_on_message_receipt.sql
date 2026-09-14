-- Message acceptance creates the durable receipt and mailbox row in one batch.
-- A media-backed message must atomically consume its READY reservation as part
-- of that acceptance; otherwise the message can be delivered while the media
-- remains READY and later be treated as unattached/expired.
CREATE TRIGGER message_receipt_attaches_media
AFTER INSERT ON message_receipts
WHEN NEW.media_upload_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM media_uploads
      WHERE id = NEW.media_upload_id
        AND relationship_id = NEW.relationship_id
        AND status = 'READY'
    ) THEN RAISE(ABORT, 'media reservation is not READY for message acceptance')
  END;

  UPDATE media_uploads
  SET status = 'ATTACHED', attached_at = NEW.server_received_at
  WHERE id = NEW.media_upload_id
    AND relationship_id = NEW.relationship_id
    AND status = 'READY';
END;
