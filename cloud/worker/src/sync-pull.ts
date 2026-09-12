import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import type { Env, MessageType } from "./types";

const DEFAULT_PULL_LIMIT = 50;
const MAX_PULL_LIMIT = 100;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

interface MailboxRow {
  message_id: string;
  sender_device_id: string;
  sender_participant: "ME" | "PARTNER";
  sender_seq: number;
  client_created_at: number;
  server_seq: number;
  server_received_at: number;
  type: MessageType;
  ciphertext: string | number[] | Uint8Array | ArrayBuffer;
  encryption_version: number;
  media_upload_id: string | null;
}

function parseSafeInteger(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_CURSOR) return null;
  return parsed;
}

function parseLimit(value: string | null): number | null {
  if (value === null || value.trim() === "") return DEFAULT_PULL_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PULL_LIMIT) return null;
  return parsed;
}

function normalizeCiphertext(
  value: string | number[] | Uint8Array | ArrayBuffer,
): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return new TextDecoder().decode(Uint8Array.from(value));
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new TextDecoder().decode(new Uint8Array(value as ArrayBuffer));
  }
  throw new TypeError("Invalid ciphertext stored in mailbox");
}

function mapMessage(row: MailboxRow) {
  return {
    messageId: row.message_id,
    senderDeviceId: row.sender_device_id,
    senderParticipant: row.sender_participant,
    senderSeq: row.sender_seq,
    createdAt: row.client_created_at,
    serverSeq: row.server_seq,
    receivedAt: row.server_received_at,
    type: row.type,
    ciphertext: normalizeCiphertext(row.ciphertext),
    encryptionVersion: row.encryption_version,
    mediaUploadId: row.media_upload_id,
  };
}

export async function pullMessages(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);

  const url = new URL(request.url);
  const after = parseSafeInteger(url.searchParams.get("after"));
  if (after === null && url.searchParams.has("after")) {
    return errorResponse("INVALID_CURSOR", "after must be a non-negative safe integer", 400);
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return errorResponse("INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_PULL_LIMIT}`, 400);
  }

  const cursor = after ?? 0;

  let relationship: { status: "PAIRING" | "ACTIVE" | "ENDED" } | null;
  try {
    relationship = await env.DB.prepare(
      `SELECT status FROM relationships WHERE id = ?1`,
    )
      .bind(device.relationshipId)
      .first<{ status: "PAIRING" | "ACTIVE" | "ENDED" }>();
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Relationship could not be read", 503);
  }

  if (!relationship || relationship.status !== "ACTIVE") {
    return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);
  }

  const now = Date.now();
  const session = env.DB.withSession("first-primary");
  let rows: MailboxRow[];

  try {
    const result = await session.prepare(
      `SELECT message_id, sender_device_id, sender_participant, sender_seq,
              client_created_at, server_seq, server_received_at, type, ciphertext,
              encryption_version, media_upload_id
       FROM mailbox_messages
       WHERE relationship_id = ?1
         AND server_seq > ?2
         AND acknowledged_at IS NULL
         AND expires_at > ?3
       ORDER BY server_seq ASC
       LIMIT ?4`,
    )
      .bind(device.relationshipId, cursor, now, limit + 1)
      .all<MailboxRow>();

    rows = result.results;
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Mailbox could not be read", 503);
  }

  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.server_seq : cursor;

  try {
    return json({
      messages: rows.map(mapMessage),
      nextCursor,
      hasMore,
    });
  } catch {
    return errorResponse("INVALID_MAILBOX_DATA", "Mailbox contains invalid stored data", 500);
  }
}
