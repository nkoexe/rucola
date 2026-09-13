import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import type { Env } from "./types";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_SERVER_SEQUENCE = Number.MAX_SAFE_INTEGER;

interface AckRequest {
  throughServerSeq?: unknown;
}

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
  } catch {
    return null;
  }
}

export async function acknowledgeMessages(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);

  const session = env.DB.withSession("first-primary");
  const relationship = await session
    .prepare(
      `SELECT status, next_server_seq
       FROM relationships
       WHERE id = ?1`,
    )
    .bind(device.relationshipId)
    .first<{ status: "PAIRING" | "ACTIVE" | "ENDED"; next_server_seq: number }>();

  if (!relationship || relationship.status !== "ACTIVE") {
    return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);
  }

  const body = await readJson(request);
  if (!body) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);

  const throughServerSeq = parseSafeServerSequence(body.throughServerSeq);
  if (throughServerSeq === null) {
    return errorResponse("INVALID_ACK_CURSOR", "throughServerSeq must be a positive safe integer", 400);
  }

  const highestServerSeq = relationship.next_server_seq - 1;
  if (throughServerSeq > highestServerSeq) {
    return errorResponse("ACK_CURSOR_AHEAD", "throughServerSeq is greater than the server's known sequence", 409);
  }

  const acknowledgedAt = Date.now();

  try {
    // Receipt acknowledgement and mailbox deletion are one D1 batch. This
    // preserves the idempotency record if the response is lost while making
    // ACK the recipient's destructive durability boundary.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE message_receipts
         SET acknowledged_at = ?1
         WHERE relationship_id = ?2
           AND server_seq <= ?3
           AND acknowledged_at IS NULL
           AND EXISTS (
             SELECT 1 FROM mailbox_messages AS m
             WHERE m.relationship_id = ?2
               AND m.message_id = message_receipts.message_id
               AND m.server_seq = message_receipts.server_seq
               AND m.server_seq <= ?3
           )
           AND EXISTS (
             SELECT 1 FROM relationships
             WHERE id = ?2 AND status = 'ACTIVE'
           )`,
      ).bind(acknowledgedAt, device.relationshipId, throughServerSeq),
      // Pull is non-destructive. Once the client has durably persisted the
      // contiguous high-water mark, the temporary mailbox copies can be
      // removed. Keep the relationship ACTIVE predicate on the destructive
      // statement too so relationship termination cannot turn this into a
      // post-termination cleanup operation.
      env.DB.prepare(
        `DELETE FROM mailbox_messages
         WHERE relationship_id = ?1
           AND server_seq <= ?2
           AND EXISTS (
             SELECT 1 FROM relationships
             WHERE id = ?1 AND status = 'ACTIVE'
           )`,
      ).bind(device.relationshipId, throughServerSeq),
    ]);

    // Repeated ACKs are deliberately successful even when the rows were
    // already removed, making the operation idempotent.
    const deleted = results[1]?.meta.changes ?? 0;

    return json({
      acknowledgedThrough: throughServerSeq,
      deleted,
      acknowledgedAt,
    });
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Mailbox acknowledgement could not be committed", 503);
  }
}
