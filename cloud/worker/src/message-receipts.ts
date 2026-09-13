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
  delivery_expires_at: number | null;
  retention_expires_at: number | null;
  acknowledged_at: number | null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function messageCiphertextHash(message: ReceiptMessage): Promise<string> {
  return sha256Hex(message.ciphertextBytes);
}

function sameReceiptPayload(
  row: ReceiptRow,
  device: AuthenticatedDevice,
  message: ReceiptMessage,
  ciphertextHash: string,
): boolean {
  return row.sender_device_id === device.id
    && row.sender_seq === message.senderSeq
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
  now = Date.now(),
): Promise<Response | null> {
  const ciphertextHash = await messageCiphertextHash(message);
  const existing = await env.DB.prepare(
    `SELECT message_id, sender_device_id, sender_seq, type, ciphertext_hash,
            encryption_version, client_created_at, media_upload_id,
            server_seq, server_received_at, delivery_expires_at,
            retention_expires_at, acknowledged_at
     FROM message_receipts
     WHERE relationship_id = ?1 AND message_id = ?2`,
  )
    .bind(device.relationshipId, message.messageId)
    .first<ReceiptRow>();

  if (existing) {
    if (!sameReceiptPayload(existing, device, message, ciphertextHash)) {
      return errorResponse("MESSAGE_ID_CONFLICT", "Message ID is already assigned to different content", 409);
    }

    // An acknowledged receipt is the durable retry/idempotency record. An
    // unacknowledged receipt only guarantees delivery while its mailbox
    // delivery window remains open. After that window, never resurrect the
    // message as a new mailbox entry under the same message identity.
    if (existing.acknowledged_at === null && existing.delivery_expires_at !== null && now >= existing.delivery_expires_at) {
      return errorResponse("MESSAGE_RETRY_EXPIRED", "Message delivery retry window has expired", 409);
    }

    return successFromReceipt(message, existing);
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

export async function durableReceiptHash(message: ReceiptMessage): Promise<string> {
  return messageCiphertextHash(message);
}
