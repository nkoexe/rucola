-- Enforce the cross-table media/message type invariant at the D1 boundary.
-- PHOTO_VIDEO messages may reference only PHOTO or VIDEO uploads.
-- Other message types must not reference media at all.
-- The existing acceptance trigger still enforces ownership, READY state,
-- expiry, and the ATTACHED transition atomically.

CREATE TRIGGER mailbox_media_message_type_invariant
BEFORE INSERT ON mailbox_messages
BEGIN
  SELECT (CASE
    WHEN NEW.type = 'PHOTO_VIDEO' AND NEW.media_upload_id IS NULL THEN
      RAISE(ABORT, 'photo/video message requires media upload')
  END);

  SELECT (CASE
    WHEN NEW.type <> 'PHOTO_VIDEO' AND NEW.media_upload_id IS NOT NULL THEN
      RAISE(ABORT, 'non-media message cannot reference media upload')
  END);

  SELECT (CASE
    WHEN NEW.type = 'PHOTO_VIDEO'
      AND NOT EXISTS (
        SELECT 1
        FROM media_uploads
        WHERE id = NEW.media_upload_id
          AND relationship_id = NEW.relationship_id
          AND media_type IN ('PHOTO', 'VIDEO')
      ) THEN
      RAISE(ABORT, 'photo/video message references incompatible media upload')
  END);
END;
