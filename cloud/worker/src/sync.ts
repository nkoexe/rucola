import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import type { AuthenticatedDevice, Env, MessageType } from "./types";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_CIPHERTEXT_BYTES = 12 * 1024;
const MAX_ENCRYPTION_VERSION = 255;
const MIN_CREATED_AT = Date.UTC(2020, 0, 1);
const MAX_FUTURE_CREATED_AT_MS = 7 * 24 * 60 * 60 * 1000;
const MAILBOX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
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

interface ValidatedPush {
  messageId: string;
  senderSeq: number;
  type: MessageType;
  ciphertext: string;
  ciphertextBytes: Uint8Array;
  encryptionVersion: number;
  createdAt: number;
  mediaUploadId: string | null;
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

function normalizeCiphertext(
  value: string | number[] | Uint8Array | ArrayBuffer,
): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value as ArrayBuffer);
  }
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

function sameImmutablePayload(existing: ExistingMessage, message: ValidatedPush): boolean {
  return existing.sender_seq === message.senderSeq
    && existing.type === message.type
    && equalBytes(normalizeCiphertext(existing.ciphertext), message.ciphertextBytes)
    && existing.encryption_version === message.encryptionVersion
    && existing.client_created_at === message.createdAt
    && existing.media_upload_id === message.mediaUploadId;
}

function successResponse(message: ValidatedPush, existing: ExistingMessage): Response {
  return json({
    messageId: message.messageId,
    senderSeq: existing.sender_seq,
    serverSeq: existing.server_seq,
    acceptedAt: existing.server_received_at,
  });
}

async function findExistingMessage(env: Env, device: AuthenticatedDevice, messageId: string): Promise<ExistingMessage | null> {
  return env.DB.prepare(
    `SELECT message_id, sender_seq, type, ciphertext, encryption_version, client_created_at,
            media_upload_id, server_seq, server_received_at
     FROM mailbox_messages
     WHERE relationship_id = ?1 AND message_id = ?2`,
  )
    .bind(device.relationshipId, messageId)
    .first<ExistingMessage>();
}

async function findSenderSequenceMessage(env: Env, device: AuthenticatedDevice, senderSeq: number): Promise<{ message_id: string } | null> {
  return env.DB.prepare(
    `SELECT message_id
     FROM mailbox_messages
     WHERE relationship_id = ?1 AND sender_device_id = ?2 AND sender_seq = ?3`,
  )
    .bind(device.relationshipId, device.id, senderSeq)
    .first<{ message_id: string }>();
}

async function classifyConflict(env: Env, device: AuthenticatedDevice, message: ValidatedPush): Promise<Response | null> {
  const existing = await findExistingMessage(env, device, message.messageId);
  if (existing) {
    if (sameImmutablePayload(existing, message)) return successResponse(message, existing);
    return errorResponse("MESSAGE_ID_CONFLICT", "Message ID is already assigned to different content", 409);
  }

  const senderSequence = await findSenderSequenceMessage(env, device, message.senderSeq);
  if (senderSequence && senderSequence.message_id !== message.messageId) {
    return errorResponse("SENDER_SEQUENCE_CONFLICT", "Sender sequence is already assigned to another message", 409);
  }
  return null;
}

async function validateMedia(env: Env, device: AuthenticatedDevice, mediaUploadId: string, now: number): Promise<Response | null> {
  const upload = await env.DB.prepare(
    `SELECT id, relationship_id, created_by_device_id, status, expires_at
     FROM media_uploads
     WHERE id = ?1`,
  )
    .bind(mediaUploadId)
    .first<MediaUpload>();

  if (!upload
    || upload.relationship_id !== device.relationshipId
    || upload.created_by_device_id !== device.id
    || upload.status !== "READY"
    || upload.expires_at <= now) {
    return errorResponse("MEDIA_CONFLICT", "Media upload is not attachable", 409);
  }
  return null;
}

async function acceptNewMessage(env: Env, device: AuthenticatedDevice, message: ValidatedPush, now: number, serverSeq: number): Promise<"success" | "retry"> {
  const expiresAt = now + MAILBOX_RETENTION_MS;

  try {
    const statements: D1PreparedStatement[] = [];

    if (message.mediaUploadId) {
      // Transition the media first. A zero-row UPDATE is still a successful D1
      // statement, so the following INSERT must require the ATTACHED state and
      // the sequence allocation must only happen when that INSERT succeeds.
      statements.push(
        env.DB.prepare(
          `UPDATE media_uploads
           SET status = 'ATTACHED', attached_at = ?1
           WHERE id = ?2
             AND relationship_id = ?3
             AND created_by_device_id = ?4
             AND status = 'READY'
             AND expires_at > ?1`,
        ).bind(now, message.mediaUploadId, device.relationshipId, device.id),
      );

      statements.push(
        env.DB.prepare(
          `INSERT INTO mailbox_messages
             (relationship_id, message_id, sender_device_id, sender_participant, sender_seq,
              client_created_at, server_seq, server_received_at, type, ciphertext,
              encryption_version, media_upload_id, expires_at)
           SELECT r.id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, m.id, ?11
           FROM relationships AS r
           JOIN media_uploads AS m
             ON m.id = ?12
            AND m.relationship_id = r.id
            AND m.created_by_device_id = ?2
            AND m.status = 'ATTACHED'
           WHERE r.id = ?13
             AND r.status = 'ACTIVE'
             AND r.next_server_seq = ?6`,
        ).bind(
          message.messageId,
          device.id,
          device.participant,
          message.senderSeq,
          message.createdAt,
          serverSeq,
          now,
          message.type,
          message.ciphertextBytes,
          message.encryptionVersion,
          expiresAt,
          message.mediaUploadId,
          device.relationshipId,
        ),
      );

      statements.push(
        env.DB.prepare(
          `UPDATE relationships
           SET next_server_seq = next_server_seq + 1
           WHERE id = ?1
             AND status = 'ACTIVE'
             AND next_server_seq = ?2
             AND EXISTS (
               SELECT 1
               FROM mailbox_messages
               WHERE relationship_id = ?1
                 AND message_id = ?3
                 AND server_seq = ?2
             )`,
        ).bind(device.relationshipId, serverSeq, message.messageId),
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
          message.messageId,
          device.id,
          device.participant,
          message.senderSeq,
          message.createdAt,
          serverSeq,
          now,
          message.type,
          message.ciphertextBytes,
          message.encryptionVersion,
          expiresAt,
          device.relationshipId,
        ),
      );

      statements.push(
        env.DB.prepare(
          `UPDATE relationships
           SET next_server_seq = next_server_seq + 1
           WHERE id = ?1
             AND status = 'ACTIVE'
             AND next_server_seq = ?2
             AND EXISTS (
               SELECT 1
               FROM mailbox_messages
               WHERE relationship_id = ?1
                 AND message_id = ?3
                 AND server_seq = ?2
             )`,
        ).bind(device.relationshipId, serverSeq, message.messageId),
      );
    }

    const results = await env.DB.batch(statements);
    const sequenceUpdate = results[results.length - 1];
    if (sequenceUpdate?.meta.changes !== 1) return "retry";

    // Verification must be sequentially consistent with the committed batch.
    // This matters once D1 read replication is enabled: an ordinary follow-up
    // read could otherwise observe a replica that predates our write.
    const session = env.DB.withSession("first-primary");
    const accepted = await session.prepare(
      `SELECT message_id, sender_seq, type, ciphertext, encryption_version, client_created_at,
              media_upload_id, server_seq, server_received_at
       FROM mailbox_messages
       WHERE relationship_id = ?1 AND message_id = ?2`,
    )
      .bind(device.relationshipId, message.messageId)
      .first<ExistingMessage>();
    const relationship = await session.prepare(
      `SELECT next_server_seq FROM relationships WHERE id = ?1 AND status = 'ACTIVE'`,
    )
      .bind(device.relationshipId)
      .first<{ next_server_seq: number }>();

    if (!accepted || relationship?.next_server_seq !== serverSeq + 1) return "retry";

    if (message.mediaUploadId) {
      const media = await session.prepare(
        `SELECT status FROM media_uploads
         WHERE id = ?1 AND relationship_id = ?2 AND created_by_device_id = ?3`,
      )
        .bind(message.mediaUploadId, device.relationshipId, device.id)
        .first<{ status: "ATTACHED" | "READY" | "PENDING" | "ABANDONED" }>();
      if (media?.status !== "ATTACHED") return "retry";
    }

    return "success";
  } catch (cause) {
    const messageText = cause instanceof Error ? cause.message.toLowerCase() : "";
    if (messageText.includes("constraint") || messageText.includes("unique") || messageText.includes("busy")) return "retry";
    throw cause;
  }
}

export async function pushMessage(env: Env, request: Request): Promise<Response> {
  const authenticated = await authenticateDevice(env, request);
  if (!authenticated) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);

  const relationship = await env.DB.prepare(
    `SELECT status FROM relationships WHERE id = ?1`,
  )
    .bind(authenticated.relationshipId)
    .first<{ status: "PAIRING" | "ACTIVE" | "ENDED" }>();
  if (!relationship || relationship.status !== "ACTIVE") {
    return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);
  }

  const parsed = await readJson(request);
  if (parsed.tooLarge) return errorResponse("PAYLOAD_TOO_LARGE", "Request body is too large", 413);
  if (!parsed.body) return errorResponse("INVALID_REQUEST", "Invalid JSON request", 400);

  let now = Date.now();
  const validation = validateRequest(parsed.body, now);
  if (!validation.value) return errorResponse(validation.status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST", validation.message, validation.status);
  const message = validation.value;

  const initialConflict = await classifyConflict(env, authenticated, message);
  if (initialConflict) return initialConflict;

  for (let attempt = 0; attempt < MAX_SERVER_SEQUENCE_ALLOCATION_RETRIES; attempt += 1) {
    if (message.mediaUploadId) {
      now = Date.now();
      const mediaConflict = await validateMedia(env, authenticated, message.mediaUploadId, now);
      if (mediaConflict) return mediaConflict;
    }

    const sequenceRow = await env.DB.prepare(
      `SELECT next_server_seq FROM relationships WHERE id = ?1 AND status = 'ACTIVE'`,
    )
      .bind(authenticated.relationshipId)
      .first<{ next_server_seq: number }>();
    if (!sequenceRow) return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);

    const result = await acceptNewMessage(env, authenticated, message, now, sequenceRow.next_server_seq);
    if (result === "success") {
      const accepted = await findExistingMessage(env, authenticated, message.messageId);
      if (!accepted) return errorResponse("DATABASE_UNAVAILABLE", "Message acceptance could not be confirmed", 500);
      return successResponse(message, accepted);
    }

    const conflict = await classifyConflict(env, authenticated, message);
    if (conflict) return conflict;
  }

  return errorResponse("DATABASE_UNAVAILABLE", "Message could not be accepted", 500);
}