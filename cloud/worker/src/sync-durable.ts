import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import {
  classifyDurableReceipt,
  durableReceiptHash,
  type ReceiptMessage,
} from "./message-receipts";
import type { AuthenticatedDevice, Env, MessageType } from "./types";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_CIPHERTEXT_BYTES = 12 * 1024;
const MAX_ENCRYPTION_VERSION = 255;
const MIN_CREATED_AT = Date.UTC(2020, 0, 1);
const MAX_FUTURE_CREATED_AT_MS = 7 * 24 * 60 * 60 * 1000;
const MAILBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SERVER_SEQUENCE_ALLOCATION_RETRIES = 16;
const MESSAGE_TYPES = new Set<MessageType>(["TEXT", "EMOJI", "PHOTO_VIDEO", "DRAWING"]);

interface PushRequest {
  messageId?: unknown;
  senderSeq?: unknown;
  type?: unknown;
  ciphertext?: unknown;
  encryptionVersion?: unknown;
  createdAt?: unknown;
  mediaUploadId?: unknown;
}

interface ValidatedPush extends ReceiptMessage {
  ciphertext: string;
}

interface ExistingMessage {
  message_id: string;
  sender_seq: number;
  type: MessageType;
  ciphertext: string | number[] | Uint8Array | ArrayBuffer;
  encryption_version: number;
  client_created_at: number;
  media_upload_id: string | null;
  server_seq: number;
  server_received_at: number;
}

interface MediaUpload {
  id: string;
  relationship_id: string;
  created_by_device_id: string;
  status: "PENDING" | "READY" | "ATTACHED" | "ABANDONED";
  expires_at: number;
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readJson(request: Request): Promise<{ body: PushRequest | null; tooLarge: boolean }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) return { body: null, tooLarge: true };
    if (parsedLength > MAX_JSON_BODY_BYTES) return { body: null, tooLarge: true };
  }
  if (!request.body) return { body: null, tooLarge: false };
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_JSON_BODY_BYTES) return { body: null, tooLarge: true };
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { body: null, tooLarge: false };
    return { body: value as PushRequest, tooLarge: false };
  } catch {
    return { body: null, tooLarge: false };
  }
}

function isBoundedIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= MAX_IDENTIFIER_BYTES && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeCiphertext(value: string | number[] | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer);
  return new Uint8Array();
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function validateRequest(body: PushRequest, now: number): { value: ValidatedPush | null; status: 400 | 413; message: string } {
  if (!isBoundedIdentifier(body.messageId)) return { value: null, status: 400, message: "Invalid messageId" };
  if (!Number.isSafeInteger(body.senderSeq) || (body.senderSeq as number) < 1) return { value: null, status: 400, message: "Invalid senderSeq" };
  if (typeof body.type !== "string" || !MESSAGE_TYPES.has(body.type as MessageType)) return { value: null, status: 400, message: "Invalid message type" };
  if (typeof body.ciphertext !== "string" || body.ciphertext.length === 0) return { value: null, status: 400, message: "Invalid ciphertext" };
  const ciphertextBytes = new TextEncoder().encode(body.ciphertext);
  if (ciphertextBytes.byteLength > MAX_CIPHERTEXT_BYTES) return { value: null, status: 413, message: "Ciphertext is too large" };
  if (!Number.isSafeInteger(body.encryptionVersion) || (body.encryptionVersion as number) < 1 || (body.encryptionVersion as number) > MAX_ENCRYPTION_VERSION) return { value: null, status: 400, message: "Invalid encryptionVersion" };
  if (!Number.isSafeInteger(body.createdAt) || (body.createdAt as number) < MIN_CREATED_AT || (body.createdAt as number) > now + MAX_FUTURE_CREATED_AT_MS) return { value: null, status: 400, message: "Invalid createdAt" };
  const mediaUploadId = body.mediaUploadId === undefined ? null : body.mediaUploadId;
  if (mediaUploadId !== null && !isBoundedIdentifier(mediaUploadId)) return { value: null, status: 400, message: "Invalid mediaUploadId" };
  if (body.type === "PHOTO_VIDEO" && mediaUploadId === null) return { value: null, status: 400, message: "PHOTO_VIDEO requires mediaUploadId" };
  if (body.type !== "PHOTO_VIDEO" && mediaUploadId !== null) return { value: null, status: 400, message: "mediaUploadId is not allowed for this message type" };
  return {
    value: {
      messageId: body.messageId,
      senderSeq: body.senderSeq as number,
      type: body.type as MessageType,
      ciphertext: body.ciphertext,
      ciphertextBytes,
      encryptionVersion: body.encryptionVersion as number,
      createdAt: body.createdAt as number,
      mediaUploadId: mediaUploadId as string | null,
    },
    status: 400,
    message: "",
  };
}

function sameMailboxPayload(existing: ExistingMessage, message: ValidatedPush): boolean {
  return existing.sender_seq === message.senderSeq
    && existing.type === message.type
    && equalBytes(normalizeCiphertext(existing.ciphertext), message.ciphertextBytes)
    && existing.encryption_version === message.encryptionVersion
    && existing.client_created_at === message.createdAt
    && existing.media_upload_id === message.mediaUploadId;
}

function successResponse(message: ReceiptMessage, serverSeq: number, acceptedAt: number): Response {
  return json({ messageId: message.messageId, senderSeq: message.senderSeq, serverSeq, acceptedAt });
}

async function classifyLegacyMailbox(env: Env, device: AuthenticatedDevice, message: ValidatedPush): Promise<Response | null> {
  const existing = await env.DB.prepare(
    `SELECT message_id, sender_seq, type, ciphertext, encryption_version, client_created_at,
            media_upload_id, server_seq, server_received_at
     FROM mailbox_messages
     WHERE relationship_id = ?1 AND message_id = ?2`,
  ).bind(device.relationshipId, message.messageId).first<ExistingMessage>();
  if (existing) {
    if (sameMailboxPayload(existing, message)) return successResponse(message, existing.server_seq, existing.server_received_at);
    return errorResponse("MESSAGE_ID_CONFLICT", "Message ID is already assigned to different content", 409);
  }
  const senderSequence = await env.DB.prepare(
    `SELECT message_id FROM mailbox_messages
     WHERE relationship_id = ?1 AND sender_device_id = ?2 AND sender_seq = ?3`,
  ).bind(device.relationshipId, device.id, message.senderSeq).first<{ message_id: string }>();
  if (senderSequence && senderSequence.message_id !== message.messageId) {
    return errorResponse("SENDER_SEQUENCE_CONFLICT", "Sender sequence is already assigned to another message", 409);
  }
  return null;
}

async function validateMedia(env: Env, device: AuthenticatedDevice, mediaUploadId: string, now: number): Promise<Response | null> {
  const upload = await env.DB.prepare(
    `SELECT id, relationship_id, created_by_device_id, status, expires_at
     FROM media_uploads WHERE id = ?1`,
  ).bind(mediaUploadId).first<MediaUpload>();
  if (!upload || upload.relationship_id !== device.relationshipId || upload.created_by_device_id !== device.id || upload.status !== "READY" || upload.expires_at <= now) {
    return errorResponse("MEDIA_CONFLICT", "Media upload is not attachable", 409);
  }
  return null;
}

async function acceptNewMessage(
  env: Env,
  device: AuthenticatedDevice,
  message: ValidatedPush,
  now: number,
  serverSeq: number,
  ciphertextHash: string,
): Promise<"success" | "retry"> {
  const expiresAt = now + MAILBOX_RETENTION_MS;
  try {
    const statements: D1PreparedStatement[] = [];

    if (message.mediaUploadId) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO mailbox_messages
             (relationship_id, message_id, sender_device_id, sender_participant, sender_seq,
              client_created_at, server_seq, server_received_at, type, ciphertext,
              encryption_version, media_upload_id, expires_at)
           SELECT r.id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, m.id, ?11
           FROM relationships AS r
           JOIN media_uploads AS m ON m.id = ?12
            AND m.relationship_id = r.id
            AND m.created_by_device_id = ?2
            AND m.status = 'READY'
            AND m.expires_at > ?7
           WHERE r.id = ?13
             AND r.status = 'ACTIVE'
             AND r.next_server_seq = ?6`,
        ).bind(
          message.messageId, device.id, device.participant, message.senderSeq,
          message.createdAt, serverSeq, now, message.type, message.ciphertextBytes,
          message.encryptionVersion, expiresAt, message.mediaUploadId, device.relationshipId,
        ),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO mailbox_messages
             (relationship_id, message_id, sender_device_id, sender_participant, sender_seq,
              client_created_at, server_seq, server_received_at, type, ciphertext,
              encryption_version, media_upload_id, expires_at)
           SELECT id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11
           FROM relationships
           WHERE id = ?12
             AND status = 'ACTIVE'
             AND next_server_seq = ?6`,
        ).bind(
          message.messageId, device.id, device.participant, message.senderSeq,
          message.createdAt, serverSeq, now, message.type, message.ciphertextBytes,
          message.encryptionVersion, expiresAt, device.relationshipId,
        ),
      );
    }

    // The receipt is derived from the mailbox row created by this batch. This
    // prevents an orphan durable receipt when the conditional mailbox insert
    // inserts zero rows because a relationship/media invariant changed.
    statements.push(
      env.DB.prepare(
        `INSERT INTO message_receipts
           (relationship_id, message_id, sender_device_id, sender_seq, type,
            ciphertext_hash, encryption_version, client_created_at, media_upload_id,
            server_seq, server_received_at, created_at)
         SELECT relationship_id, message_id, sender_device_id, sender_seq, type,
                ?1, encryption_version, client_created_at, media_upload_id,
                server_seq, server_received_at, ?2
         FROM mailbox_messages
         WHERE relationship_id = ?3
           AND message_id = ?4
           AND server_seq = ?5`,
      ).bind(ciphertextHash, now, device.relationshipId, message.messageId, serverSeq),
    );

    if (message.mediaUploadId) {
      statements.push(
        env.DB.prepare(
          `UPDATE media_uploads SET status = 'ATTACHED', attached_at = ?1
           WHERE id = ?2
             AND relationship_id = ?3
             AND created_by_device_id = ?4
             AND status = 'READY'
             AND expires_at > ?1
             AND EXISTS (
               SELECT 1 FROM mailbox_messages
               WHERE relationship_id = ?3
                 AND message_id = ?5
                 AND server_seq = ?6
                 AND media_upload_id = ?2
             )`,
        ).bind(now, message.mediaUploadId, device.relationshipId, device.id, message.messageId, serverSeq),
      );
    }

    statements.push(
      env.DB.prepare(
        `UPDATE relationships SET next_server_seq = next_server_seq + 1
         WHERE id = ?1 AND status = 'ACTIVE' AND next_server_seq = ?2`,
      ).bind(device.relationshipId, serverSeq),
    );

    await env.DB.batch(statements);

    const session = env.DB.withSession("first-primary");
    const receipt = await session.prepare(
      `SELECT server_seq, server_received_at FROM message_receipts
       WHERE relationship_id = ?1 AND message_id = ?2`,
    ).bind(device.relationshipId, message.messageId).first<{ server_seq: number; server_received_at: number }>();
    const mailbox = await session.prepare(
      `SELECT message_id, sender_seq, type, ciphertext, encryption_version,
              client_created_at, media_upload_id, server_seq, server_received_at
       FROM mailbox_messages
       WHERE relationship_id = ?1 AND message_id = ?2`,
    ).bind(device.relationshipId, message.messageId).first<ExistingMessage>();
    const relationship = await session.prepare(
      `SELECT next_server_seq FROM relationships WHERE id = ?1 AND status = 'ACTIVE'`,
    ).bind(device.relationshipId).first<{ next_server_seq: number }>();

    if (!receipt || !mailbox || relationship?.next_server_seq !== serverSeq + 1) return "retry";
    if (!sameMailboxPayload(mailbox, message)) return "retry";

    if (message.mediaUploadId) {
      const media = await session.prepare(
        `SELECT status FROM media_uploads
         WHERE id = ?1 AND relationship_id = ?2 AND created_by_device_id = ?3`,
      ).bind(message.mediaUploadId, device.relationshipId, device.id).first<{ status: MediaUpload["status"] }>();
      if (media?.status !== "ATTACHED") return "retry";
    }
    return "success";
  } catch (cause) {
    const text = cause instanceof Error ? cause.message.toLowerCase() : "";
    if (text.includes("constraint") || text.includes("unique") || text.includes("busy")) return "retry";
    throw cause;
  }
}

export async function pushMessageDurable(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);

  const relationship = await env.DB.prepare(`SELECT status FROM relationships WHERE id = ?1`)
    .bind(device.relationshipId).first<{ status: "PAIRING" | "ACTIVE" | "ENDED" }>();
  if (!relationship || relationship.status !== "ACTIVE") return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);

  const parsed = await readJson(request);
  if (parsed.tooLarge) return errorResponse("PAYLOAD_TOO_LARGE", "Request body is too large", 413);
  if (!parsed.body) return errorResponse("INVALID_REQUEST", "Invalid JSON request", 400);

  const now = Date.now();
  const validation = validateRequest(parsed.body, now);
  if (!validation.value) return errorResponse(validation.status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST", validation.message, validation.status);
  const message = validation.value;

  const durableConflict = await classifyDurableReceipt(env, device, message);
  if (durableConflict) return durableConflict;
  const legacyConflict = await classifyLegacyMailbox(env, device, message);
  if (legacyConflict) return legacyConflict;

  const ciphertextHash = await durableReceiptHash(message);
  for (let attempt = 0; attempt < MAX_SERVER_SEQUENCE_ALLOCATION_RETRIES; attempt += 1) {
    const currentNow = Date.now();
    if (message.mediaUploadId) {
      const mediaConflict = await validateMedia(env, device, message.mediaUploadId, currentNow);
      if (mediaConflict) return mediaConflict;
    }

    const sequenceRow = await env.DB.prepare(
      `SELECT next_server_seq FROM relationships WHERE id = ?1 AND status = 'ACTIVE'`,
    ).bind(device.relationshipId).first<{ next_server_seq: number }>();
    if (!sequenceRow) return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);

    const result = await acceptNewMessage(
      env, device, message, currentNow, sequenceRow.next_server_seq, ciphertextHash,
    );
    if (result === "success") {
      const receipt = await env.DB.prepare(
        `SELECT server_seq, server_received_at FROM message_receipts
         WHERE relationship_id = ?1 AND message_id = ?2`,
      ).bind(device.relationshipId, message.messageId).first<{ server_seq: number; server_received_at: number }>();
      if (!receipt) return errorResponse("DATABASE_UNAVAILABLE", "Message acceptance could not be confirmed", 500);
      return successResponse(message, receipt.server_seq, receipt.server_received_at);
    }

    const conflict = await classifyDurableReceipt(env, device, message);
    if (conflict) return conflict;
    const legacy = await classifyLegacyMailbox(env, device, message);
    if (legacy) return legacy;
  }

  return errorResponse("DATABASE_UNAVAILABLE", "Message could not be accepted", 500);
}
