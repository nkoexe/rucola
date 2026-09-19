import type { Message, MessageType } from '../domain/models';
import type { AesGcmParts, AesGcmProvider } from './expoAesGcm';
import { base64UrlToBytes, bytesToBase64Url, utf8Decode, utf8Encode } from './encoding';

export const ENCRYPTION_VERSION = 1;
const ENVELOPE_VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CIPHERTEXT_LENGTH = 64 * 1024;

export class CryptoDecryptionError extends Error {
  constructor(message = 'Unable to decrypt inbound message.') {
    super(message);
    this.name = 'CryptoDecryptionError';
  }
}

export interface EncryptedMessageInput {
  messageId: string;
  senderSeq: number;
  type: MessageType;
  encryptionVersion: number;
  ciphertext: string;
}

export interface AesGcmSyncCodecOptions {
  relationshipId: string;
  relationshipKey: string;
  provider: AesGcmProvider;
}

function isSupportedType(type: MessageType): type is 'TEXT' | 'EMOJI' {
  return type === 'TEXT' || type === 'EMOJI';
}

function assertRelationshipId(relationshipId: string): void {
  if (!relationshipId || relationshipId.length > 128) throw new Error('Relationship ID is invalid.');
}

function assertMessageContext(relationshipId: string, messageId: string, type: MessageType, senderSeq: number, encryptionVersion: number): void {
  assertRelationshipId(relationshipId);
  if (!messageId || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) throw new Error('Message ID is invalid.');
  if (!isSupportedType(type)) throw new Error('Message type is not supported by the current encrypted codec.');
  if (!Number.isSafeInteger(senderSeq) || senderSeq < 1) throw new Error('Sender sequence is invalid.');
  if (encryptionVersion !== ENCRYPTION_VERSION) throw new Error('Encryption version is unsupported.');
}

function buildAdditionalData(relationshipId: string, messageId: string, type: MessageType, senderSeq: number, encryptionVersion: number): Uint8Array {
  return utf8Encode(JSON.stringify([
    'rucola-e2e-v1',
    relationshipId,
    messageId,
    type,
    senderSeq,
    encryptionVersion,
  ]));
}

function encodeEnvelope(parts: AesGcmParts): string {
  if (parts.iv.length !== NONCE_BYTES) throw new Error('AES-GCM provider returned an invalid nonce.');
  if (parts.tag.length !== TAG_BYTES) throw new Error('AES-GCM provider returned an invalid authentication tag.');
  if (parts.ciphertext.length === 0) throw new Error('AES-GCM provider returned empty ciphertext.');

  return [
    ENVELOPE_VERSION,
    bytesToBase64Url(parts.iv),
    bytesToBase64Url(parts.ciphertext),
    bytesToBase64Url(parts.tag),
  ].join('.');
}

function decodeEnvelope(value: string): AesGcmParts {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CIPHERTEXT_LENGTH) throw new CryptoDecryptionError();
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw new CryptoDecryptionError();

  try {
    const iv = base64UrlToBytes(parts[1] ?? '');
    const ciphertext = base64UrlToBytes(parts[2] ?? '');
    const tag = base64UrlToBytes(parts[3] ?? '');
    if (iv.length !== NONCE_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) throw new Error();
    return { iv, ciphertext, tag };
  } catch {
    throw new CryptoDecryptionError();
  }
}

function encodePayload(message: Message): Uint8Array {
  if (message.body.trim() === '') throw new Error('Message body cannot be empty.');
  return utf8Encode(JSON.stringify({ body: message.body, mediaReference: null }));
}

function decodePayload(value: Uint8Array): { body: string; mediaReference: null } {
  try {
    const payload = JSON.parse(utf8Decode(value)) as unknown;
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof (payload as { body?: unknown }).body !== 'string' ||
      (payload as { body: string }).body.trim() === '' ||
      (payload as { mediaReference?: unknown }).mediaReference !== null
    ) {
      throw new Error();
    }
    return { body: (payload as { body: string }).body, mediaReference: null };
  } catch {
    throw new CryptoDecryptionError();
  }
}

export class AesGcmSyncCodec {
  readonly encryptionVersion = ENCRYPTION_VERSION;

  private readonly relationshipId: string;
  private readonly relationshipKey: string;
  private readonly provider: AesGcmProvider;

  constructor(options: AesGcmSyncCodecOptions) {
    assertRelationshipId(options.relationshipId);
    if (!options.relationshipKey) throw new Error('Relationship encryption key is required.');
    this.relationshipId = options.relationshipId;
    this.relationshipKey = options.relationshipKey;
    this.provider = options.provider;
  }

  async encrypt(message: Message, senderSeq: number): Promise<string> {
    if (message.relationshipId !== this.relationshipId) throw new Error('Message belongs to a different relationship.');
    if (message.participant !== 'ME') throw new Error('Only local messages can be encrypted.');
    assertMessageContext(this.relationshipId, message.id, message.type, senderSeq, this.encryptionVersion);

    const additionalData = buildAdditionalData(this.relationshipId, message.id, message.type, senderSeq, this.encryptionVersion);
    const sealed = await this.provider.encrypt(encodePayload(message), this.relationshipKey, additionalData);
    return encodeEnvelope(sealed);
  }

  async decrypt(message: EncryptedMessageInput): Promise<{ type: MessageType; body: string; mediaReference: null }> {
    try {
      assertMessageContext(this.relationshipId, message.messageId, message.type, message.senderSeq, message.encryptionVersion);
      const additionalData = buildAdditionalData(this.relationshipId, message.messageId, message.type, message.senderSeq, message.encryptionVersion);
      const plaintext = await this.provider.decrypt(decodeEnvelope(message.ciphertext), this.relationshipKey, additionalData);
      const payload = decodePayload(plaintext);
      return { type: message.type, body: payload.body, mediaReference: payload.mediaReference };
    } catch (cause) {
      if (cause instanceof CryptoDecryptionError) throw cause;
      throw new CryptoDecryptionError();
    }
  }
}
