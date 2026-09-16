import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import type { Env } from "./types";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_SERVER_SEQUENCE = Number.MAX_SAFE_INTEGER;

interface AckRequest { throughServerSeq?: unknown; }

function parseSafeServerSequence(value: unknown): number | null {
  if (!Number.isSafeInteger(value)) return null;
  if ((value as number) < 1 || (value as number) > MAX_SERVER_SEQUENCE) return null;
  return value as number;
}

async function readJson(request: Request): Promise<AckRequest | null> {
  const contentType = request.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BODY_BYTES) return null;
  }
  if (!request.body) return null;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_JSON_BODY_BYTES) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as AckRequest;
  } catch { return null; }
}

export async function acknowledgeMessages(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);

  const session = env.DB.withSession("first-primary");
  const relationship = await session.prepare(`SELECT status, next_server_seq FROM relationships WHERE id = ?1`)
    .bind(device.relationshipId)
    .first<{ status: "PAIRING" | "ACTIVE" | "ENDED"; next_server_seq: number }>();
  if (!relationship || relationship.status !== "ACTIVE") return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);

  const body = await readJson(request);
  if (!body) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);
  const throughServerSeq = parseSafeServerSequence(body.throughServerSeq);
  if (throughServerSeq === null) return errorResponse("INVALID_ACK_CURSOR", "throughServerSeq must be a positive safe integer", 400);

  const highestServerSeq = relationship.next_server_seq - 1;
  if (throughServerSeq > highestServerSeq) return errorResponse("ACK_CURSOR_AHEAD", "throughServerSeq is greater than the server's known sequence", 409);

  const delivered = await session.prepare(
    `SELECT MAX(server_seq) AS max_delivered
     FROM message_receipts
     WHERE relationship_id = ?1
       AND delivered_to_device_id = ?2
       AND delivered_at IS NOT NULL
       AND sender_device_id != ?2`,
  ).bind(device.relationshipId, device.id).first<{ max_delivered: number | null }>();
  const maxDelivered = delivered?.max_delivered ?? 0;

  if (throughServerSeq > maxDelivered) {
    // Receipts are intentionally retained longer than mailbox messages. Once
    // both the mailbox row and its receipt have expired, the device's local
    // cursor may still legitimately point past that old message. There is
    // nothing left to acknowledge in that case, so treating the ACK as
    // idempotent lets a long-offline client recover without weakening the
    // protection for any mailbox row that is still present.
    const outstanding = await session.prepare(
      `SELECT 1 AS outstanding
       FROM mailbox_messages AS m
       WHERE m.relationship_id = ?1
         AND m.server_seq <= ?2
         AND m.sender_device_id != ?3
         AND m.acknowledged_at IS NULL
       LIMIT 1`,
    ).bind(device.relationshipId, throughServerSeq, device.id).first<{ outstanding: number }>();
    if (outstanding) return errorResponse("ACK_NOT_DELIVERED", "throughServerSeq has not been delivered to this device", 409);
  }

  const missingDelivery = await session.prepare(
    `SELECT 1 AS missing
     FROM mailbox_messages AS m
     WHERE m.relationship_id = ?1
       AND m.server_seq <= ?2
       AND m.sender_device_id != ?3
       AND m.acknowledged_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM message_receipts AS r
         WHERE r.relationship_id = m.relationship_id
           AND r.message_id = m.message_id
           AND r.server_seq = m.server_seq
           AND r.sender_device_id = m.sender_device_id
           AND r.delivered_to_device_id = ?3
           AND r.delivered_at IS NOT NULL
       )
     LIMIT 1`,
  ).bind(device.relationshipId, throughServerSeq, device.id).first<{ missing: number }>();
  if (missingDelivery) return errorResponse("ACK_NOT_DELIVERED", "throughServerSeq skips an inbound message that has not been delivered to this device", 409);

  const acknowledgedAt = Date.now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE message_receipts
         SET acknowledged_at = ?1
         WHERE relationship_id = ?2
           AND server_seq <= ?3
           AND sender_device_id != ?4
           AND delivered_to_device_id = ?4
           AND delivered_at IS NOT NULL
           AND acknowledged_at IS NULL
           AND EXISTS (
             SELECT 1 FROM mailbox_messages AS m
             WHERE m.relationship_id = ?2
               AND m.message_id = message_receipts.message_id
               AND m.server_seq = message_receipts.server_seq
               AND m.sender_device_id = message_receipts.sender_device_id
               AND m.sender_device_id != ?4
           )
           AND EXISTS (
             SELECT 1 FROM relationships
             WHERE id = ?2 AND status = 'ACTIVE'
           )`,
      ).bind(acknowledgedAt, device.relationshipId, throughServerSeq, device.id),
      env.DB.prepare(
        `DELETE FROM mailbox_messages
         WHERE relationship_id = ?1
           AND server_seq <= ?2
           AND sender_device_id != ?3
           AND EXISTS (
             SELECT 1 FROM message_receipts AS r
             WHERE r.relationship_id = mailbox_messages.relationship_id
               AND r.message_id = mailbox_messages.message_id
               AND r.server_seq = mailbox_messages.server_seq
               AND r.sender_device_id = mailbox_messages.sender_device_id
               AND r.delivered_to_device_id = ?3
               AND r.delivered_at IS NOT NULL
               AND r.acknowledged_at IS NOT NULL
           )
           AND EXISTS (
             SELECT 1 FROM relationships
             WHERE id = ?1 AND status = 'ACTIVE'
           )`,
      ).bind(device.relationshipId, throughServerSeq, device.id),
    ]);

    const deleted = results[1]?.meta.changes ?? 0;
    return json({ acknowledgedThrough: throughServerSeq, deleted, acknowledgedAt });
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Mailbox acknowledgement could not be committed", 503);
  }
}
