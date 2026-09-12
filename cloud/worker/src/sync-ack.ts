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

  const relationship = await env.DB.prepare(
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
    // The acknowledgement is intentionally destructive: once the client has
    // durably persisted the contiguous high-water mark, the temporary mailbox
    // copies can be removed. The DELETE is scoped to the authenticated
    // relationship, so a client can never acknowledge another relationship.
    const result = await env.DB.prepare(
      `DELETE FROM mailbox_messages
       WHERE relationship_id = ?1
         AND server_seq <= ?2`,
    )
      .bind(device.relationshipId, throughServerSeq)
      .run();

    // D1's changes result is only used for observability; repeated ACKs are
    // deliberately successful even when the rows were already removed.
    const deleted = result.meta.changes ?? 0;

    return json({
      acknowledgedThrough: throughServerSeq,
      deleted,
      acknowledgedAt,
    });
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Mailbox acknowledgement could not be committed", 503);
  }
}
