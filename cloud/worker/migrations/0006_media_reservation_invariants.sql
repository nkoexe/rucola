-- Keep media size/type constraints at the D1 boundary as well as in the API.
-- The initial usable product supports PHOTO and VIDEO reservations. DRAWING remains
-- a protocol-level type for future use and is intentionally not accepted by the API.

CREATE TRIGGER media_upload_size_invariant
BEFORE INSERT ON media_uploads
BEGIN
  SELECT CASE
    WHEN NEW.media_type IN ('PHOTO', 'DRAWING')
      AND NEW.size_bytes > (20 * 1024 * 1024) THEN
      RAISE(ABORT, 'image media exceeds 20 MiB limit')
  END;

  SELECT CASE
    WHEN NEW.media_type = 'VIDEO'
      AND NEW.size_bytes > (100 * 1024 * 1024) THEN
      RAISE(ABORT, 'video media exceeds 100 MiB limit')
  END;
END;

CREATE TRIGGER media_upload_mime_invariant
BEFORE INSERT ON media_uploads
BEGIN
  SELECT CASE
    WHEN NEW.media_type = 'PHOTO'
      AND NEW.declared_mime NOT IN (
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif'
      ) THEN
      RAISE(ABORT, 'unsupported photo MIME type')
  END;

  SELECT CASE
    WHEN NEW.media_type = 'VIDEO'
      AND NEW.declared_mime NOT IN (
        'video/mp4',
        'video/quicktime',
        'video/webm'
      ) THEN
      RAISE(ABORT, 'unsupported video MIME type')
  END;
END;
