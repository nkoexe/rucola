-- Enforce the message acceptance invariants at the database boundary.
-- A mailbox row is only considered committed when it also advances the
-- relationship sequence and, for media messages, consumes its READY upload.
-- RAISE(ABORT) makes D1 roll back the whole batch if either invariant fails.

CREATE TRIGGER mailbox_message_acceptance_invariants
AFTER INSERT ON mailbox_messages
BEGIN
  UPDATE relationships
     SET next_server_seq = next_server_seq + 1
   WHERE id = NEW.relationship_id
     AND status = 'ACTIVE'
     AND next_server_seq = NEW.server_seq;

  SELECT (CASE
    WHEN changes() <> 1 THEN
      RAISE(ABORT, 'mailbox acceptance sequence invariant violated')
  END);

  UPDATE media_uploads
     SET status = 'ATTACHED',
         attached_at = NEW.server_received_at
   WHERE NEW.media_upload_id IS NOT NULL
     AND id = NEW.media_upload_id
     AND relationship_id = NEW.relationship_id
     AND created_by_device_id = NEW.sender_device_id
     AND status = 'READY'
     AND expires_at > NEW.server_received_at;

  SELECT (CASE
    WHEN NEW.media_upload_id IS NOT NULL AND changes() <> 1 THEN
      RAISE(ABORT, 'mailbox acceptance media invariant violated')
  END);
END;
