const CLEANUP_BATCH_SIZE = 50;

interface MediaCleanupRow {
  id: string;
  object_key: string;
}

interface ReceiptCleanupRow {
  relationship_id: string;
  message_id: string;
}

async function deleteMediaObject(env: Env, objectKey: string): Promise<boolean> {
  try {
    await env.MEDIA_BUCKET.delete(objectKey);
    return true;
  } catch {
    return false;
  }
}

async function claimExpiredMedia(env: Env, now: number): Promise<MediaCleanupRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, object_key
       FROM media_uploads
      WHERE status IN ('PENDING', 'READY')
        AND expires_at <= ?
      ORDER BY expires_at
      LIMIT ?`,
  )
    .bind(now, CLEANUP_BATCH_SIZE)
    .all<MediaCleanupRow>();

  const claimed: MediaCleanupRow[] = [];
  for (const row of result.results) {
    const updated = await env.DB.prepare(
      `UPDATE media_uploads
          SET status = 'ABANDONED'
        WHERE id = ?
          AND status IN ('PENDING', 'READY')
          AND expires_at <= ?`,
    )
      .bind(row.id, now)
      .run();
    if ((updated.meta.changes ?? 0) === 1) claimed.push(row);
  }
  return claimed;
}

async function claimUnreferencedAttachedMedia(env: Env): Promise<MediaCleanupRow[]> {
  const result = await env.DB.prepare(
    `SELECT m.id, m.object_key
       FROM media_uploads m
       LEFT JOIN message_receipts r
         ON r.relationship_id = m.relationship_id
        AND r.media_upload_id = m.id
      WHERE m.status = 'ATTACHED'
        AND r.message_id IS NULL
      ORDER BY m.attached_at
      LIMIT ?`,
  )
    .bind(CLEANUP_BATCH_SIZE)
    .all<MediaCleanupRow>();

  const claimed: MediaCleanupRow[] = [];
  for (const row of result.results) {
    const updated = await env.DB.prepare(
      `UPDATE media_uploads
          SET status = 'ABANDONED'
        WHERE id = ?
          AND status = 'ATTACHED'
          AND NOT EXISTS (
            SELECT 1
              FROM message_receipts
             WHERE message_receipts.relationship_id = media_uploads.relationship_id
               AND message_receipts.media_upload_id = media_uploads.id
          )`,
    )
      .bind(row.id)
      .run();
    if ((updated.meta.changes ?? 0) === 1) claimed.push(row);
  }
  return claimed;
}

async function finalizeMediaCleanup(env: Env, rows: MediaCleanupRow[]): Promise<number> {
  let deleted = 0;
  for (const row of rows) {
    if (!(await deleteMediaObject(env, row.object_key))) continue;

    const result = await env.DB.prepare(
      `DELETE FROM media_uploads
        WHERE id = ?
          AND status = 'ABANDONED'`,
    )
      .bind(row.id)
      .run();
    if ((result.meta.changes ?? 0) === 1) deleted += 1;
  }
  return deleted;
}

async function cleanupExpiredReceipts(env: Env, now: number): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT r.relationship_id, r.message_id
       FROM message_receipts r
       LEFT JOIN mailbox_messages m
         ON m.relationship_id = r.relationship_id
        AND m.message_id = r.message_id
      WHERE r.retention_expires_at <= ?
        AND m.message_id IS NULL
      ORDER BY r.retention_expires_at
      LIMIT ?`,
  )
    .bind(now, CLEANUP_BATCH_SIZE)
    .all<ReceiptCleanupRow>();

  let deleted = 0;
  for (const row of result.results) {
    const result = await env.DB.prepare(
      `DELETE FROM message_receipts
        WHERE relationship_id = ?
          AND message_id = ?
          AND retention_expires_at <= ?
          AND NOT EXISTS (
            SELECT 1
              FROM mailbox_messages
             WHERE mailbox_messages.relationship_id = message_receipts.relationship_id
               AND mailbox_messages.message_id = message_receipts.message_id
          )`,
    )
      .bind(row.relationship_id, row.message_id, now)
      .run();
    if ((result.meta.changes ?? 0) === 1) deleted += 1;
  }
  return deleted;
}

async function cleanupExpiredMailbox(env: Env, now: number): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM mailbox_messages
      WHERE expires_at <= ?
      LIMIT ?`,
  )
    .bind(now, CLEANUP_BATCH_SIZE)
    .run();
  return result.meta.changes ?? 0;
}

export interface CleanupResult {
  expiredMailbox: number;
  expiredReceipts: number;
  mediaObjectsDeleted: number;
}

export async function runCleanup(env: Env, now = Date.now()): Promise<CleanupResult> {
  // Mailbox rows can expire after their 14-day delivery guarantee. Receipts
  // remain independently retained for idempotency, so mailbox deletion must
  // not be coupled to receipt deletion.
  const expiredMailbox = await cleanupExpiredMailbox(env, now);

  // Retained receipts are removed only after their mailbox row is gone. This
  // also releases the FK dependency that protects ATTACHED media.
  const expiredReceipts = await cleanupExpiredReceipts(env, now);

  // Claim first, then touch R2. The ABANDONED state prevents a concurrent
  // push from attaching an expired READY upload while R2 cleanup is running.
  const expiredMedia = await claimExpiredMedia(env, now);
  const orphanedAttachedMedia = await claimUnreferencedAttachedMedia(env);
  const mediaObjectsDeleted = await finalizeMediaCleanup(env, [
    ...expiredMedia,
    ...orphanedAttachedMedia,
  ]);

  return { expiredMailbox, expiredReceipts, mediaObjectsDeleted };
}

import type { Env } from "./types";
