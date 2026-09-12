import { errorResponse, json } from "./http";
import type { AuthenticatedDevice, Env, MessageType } from "./types";

export interface ReceiptMessage {
  messageId: string;
  senderSeq: number;
  type: MessageType;
  ciphertextBytes: Uint8Array;
  encryptionVersion: number;
  createdAt: number;
  mediaUploadId: string | null;
}

interface ReceiptRow {
  message_id: string;
  sender_device_id: string;
  sender_seq: number;
  type: MessageType;
  ciphertext_hash: string;
  encryption_version: number;
  client_created_at: number;
  media_upload_id: string | null;
  server_seq: number;
  server_received_at: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function messageCiphertextHash(message: ReceiptMessage): Promise<string> {
  return sha256Hex(message.ciphertextBytes);
}

function sameReceiptPayload(row: ReceiptRow, message: ReceiptMessage, ciphertextHash: string): boolean {
  return row.sender_seq === message.senderSeq
    && row.type === message.type
    && row.ciphertext_hash === ciphertextHash
    && row.encryption_version === message.encryptionVersion
    && row.client_created_at === message.createdAt
    && row.media_upload_id === message.mediaUploadId;
}

function successFromReceipt(message: ReceiptMessage, row: ReceiptRow): Response {
  return json({
    messageId: message.messageId,
    senderSeq: row.sender_seq,
    serverSeq: row.server_seq,
    acceptedAt: row.server_received_at,
  });
}

export async function classifyDurableReceipt(
  env: Env,
  device: AuthenticatedDevice,
  message: ReceiptMessage,
): Promise<Response | null> {
  const ciphertextHash = await messageCiphertextHash(message);
  const existing = await env.DB.prepare(
    `SELECT message_id, sender_device_id, sender_seq, type, ciphertext_hash,
            encryption_version, client_created_at, media_upload_id,
            server_seq, server_received_at
     FROM message_receipts
     WHERE relationship_id = ?1 AND message_id = ?2`,
  )
    .bind(device.relationshipId, message.messageId)
    .first<ReceiptRow>();

  if (existing) {
    if (sameReceiptPayload(existing, message, ciphertextHash)) return successFromReceipt(message, existing);
    return errorResponse("MESSAGE_ID_CONFLICT", "Message ID is already assigned to different content", 409);
  }

  const senderSequence = await env.DB.prepare(
    `SELECT message_id
     FROM message_receipts
     WHERE relationship_id = ?1 AND sender_device_id = ?2 AND sender_seq = ?3`,
  )
    .bind(device.relationshipId, device.id, message.senderSeq)
    .first<{ message_id: string }>();

  if (senderSequence && senderSequence.message_id !== message.messageId) {
    return errorResponse("SENDER_SEQUENCE_CONFLICT", "Sender sequence is already assigned to another message", 409);
  }

  return null;
}

export function receiptInsert(
  env: Env,
  device: AuthenticatedDevice,
  message: ReceiptMessage,
  ciphertextHash: string,
  serverSeq: number,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO message_receipts
       (relationship_id, message_id, sender_device_id, sender_seq, type,
        ciphertext_hash, encryption_version, client_created_at, media_upload_id,
        server_seq, server_received_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).bind(
    device.relationshipId,
    message.messageId,
    device.id,
    message.senderSeq,
    message.type,
    ciphertextHash,
    message.encryptionVersion,
    message.createdAt,
    message.mediaUploadId,
    serverSeq,
    now,
    now,
  );
}

export async function durableReceiptHash(message: ReceiptMessage): Promise<string> {
  return messageCiphertextHash(message);
}
