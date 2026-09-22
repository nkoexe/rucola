import { cpace } from '@cipherman/pake-js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { canonicalizePairingCode } from './pairingTransport.ts';
import { base64ToBytes, bytesToBase64, utf8Encode } from '../crypto/encoding.ts';

export const PAIRING_HANDSHAKE_VERSION = 'rucola-cpace20-v1';
const INITIATOR_ID = utf8Encode('A_initiator');
const RESPONDER_ID = utf8Encode('B_responder');
const CONFIRMATION_TEXT = utf8Encode(PAIRING_HANDSHAKE_VERSION + ':confirmed');
const WRAP_INFO = utf8Encode(PAIRING_HANDSHAKE_VERSION + ':wrap');
const CONFIRM_INFO = utf8Encode(PAIRING_HANDSHAKE_VERSION + ':confirm');

export interface PairingHandshakeInit {
  sessionId: string;
  ephemeralSecret: string;
  share: string;
}

export interface PairingHandshakeSecrets {
  sessionId: string;
  ephemeralSecret: string;
  ownShare: string;
  role: 'INITIATOR' | 'RESPONDER';
  relationshipKeyCommitment: string;
}

function prependLength(value: Uint8Array): Uint8Array {
  if (value.length >= 128) throw new Error('Pairing protocol identity is too long.');
  return new Uint8Array([value.length, ...value]);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function buildChannelIdentifier(): Uint8Array {
  return concatBytes(
    prependLength(INITIATOR_ID),
    prependLength(RESPONDER_ID),
  );
}

function buildAssociatedData(role: 'INITIATOR' | 'RESPONDER', commitment: string): Uint8Array {
  return utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    role,
    commitment,
  ]));
}

function decodeSessionId(value: string): Uint8Array {
  const bytes = base64ToBytes(value);
  if (bytes.length !== 16) throw new Error('Pairing session is invalid.');
  return bytes;
}

function decodeShare(value: string): Uint8Array {
  const bytes = base64ToBytes(value);
  if (bytes.length !== 32) throw new Error('Pairing share is invalid.');
  return bytes;
}

function normalizeRelationshipKeyLocal(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Relationship encryption key is invalid.');
  }
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length !== 32) throw new Error();
    return bytesToBase64(bytes);
  } catch {
    throw new Error('Relationship encryption key is invalid.');
  }
}

function deriveKey(isk: Uint8Array, sessionId: Uint8Array, info: Uint8Array): string {
  return bytesToBase64(hkdf(sha256, isk, sessionId, info, 32));
}

function sessionInputs(
  sessionId: string,
  relationshipKeyCommitment: string,
) {
  const sid = decodeSessionId(sessionId);
  if (!/^[0-9a-f]{64}$/.test(relationshipKeyCommitment)) {
    throw new Error('Pairing commitment is invalid.');
  }
  return {
    sid,
    initiatorAD: buildAssociatedData('INITIATOR', relationshipKeyCommitment),
    responderAD: buildAssociatedData('RESPONDER', relationshipKeyCommitment),
  };
}

function pairingInputs(
  pairingCode: string,
  sessionId: string,
  relationshipKeyCommitment: string,
) {
  const { sid } = sessionInputs(sessionId, relationshipKeyCommitment);
  return {
    PRS: utf8Encode(canonicalizePairingCode(pairingCode)),
    sid,
    CI: buildChannelIdentifier(),
  };
}

export function createPairingSessionId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Pairing session must be 16 bytes.');
  return bytesToBase64(bytes);
}

export async function generatePairingSessionId(): Promise<string> {
  if (globalThis.crypto?.getRandomValues) {
    return createPairingSessionId(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  }
  const { getRandomBytesAsync } = await import('expo-crypto');
  return createPairingSessionId(await getRandomBytesAsync(16));
}

async function aesProvider() {
  return (await import('../crypto/expoAesGcm.ts')).expoAesGcmProvider;
}

export function createPairingHandshake(
  sessionId: string,
  pairingCode: string,
  relationshipKeyCommitment: string,
): PairingHandshakeInit {
  const { PRS, sid, CI } = pairingInputs(pairingCode, sessionId, relationshipKeyCommitment);
  const init = cpace.ristretto255.init({ PRS, sid, CI });
  return {
    sessionId,
    ephemeralSecret: bytesToBase64(init.ephemeralSecret),
    share: bytesToBase64(init.share),
  };
}

export async function derivePairingKeys(
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<{ wrapKey: string; confirmKey: string }> {
  const { sid, initiatorAD, responderAD } = sessionInputs(
    secrets.sessionId,
    secrets.relationshipKeyCommitment,
  );
  const own = {
    ephemeralSecret: base64ToBytes(secrets.ephemeralSecret),
    share: decodeShare(secrets.ownShare),
  };
  if (own.ephemeralSecret.length !== 32) throw new Error('Pairing ephemeral secret is invalid.');
  const peerShare = decodeShare(peerShareBase64);

  const isk = cpace.ristretto255.deriveIskInitiatorResponder({
    ephemeralSecret: own.ephemeralSecret,
    ownShare: own.share,
    peerShare,
    ownAD: secrets.role === 'INITIATOR' ? initiatorAD : responderAD,
    peerAD: secrets.role === 'INITIATOR' ? responderAD : initiatorAD,
    sid,
    role: secrets.role === 'INITIATOR' ? 'initiator' : 'responder',
  });

  return {
    wrapKey: deriveKey(isk, sid, WRAP_INFO),
    confirmKey: deriveKey(isk, sid, CONFIRM_INFO),
  };
}

export async function encryptRelationshipKey(
  relationshipKey: string,
  relationshipKeyCommitment: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const normalizedKey = normalizeRelationshipKeyLocal(relationshipKey);
  const { wrapKey } = await derivePairingKeys(secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    relationshipKeyCommitment,
  ]));
  const provider = await aesProvider();
  const parts = await provider.encrypt(utf8Encode(normalizedKey), wrapKey, aad);
  return [
    PAIRING_HANDSHAKE_VERSION,
    bytesToBase64(parts.iv),
    bytesToBase64(parts.ciphertext),
    bytesToBase64(parts.tag),
  ].join('.');
}

export async function decryptRelationshipKey(
  envelope: string,
  relationshipKeyCommitment: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const fields = envelope.split('.');
  if (fields.length !== 4 || fields[0] !== PAIRING_HANDSHAKE_VERSION) {
    throw new Error('Pairing handoff is invalid.');
  }
  const { wrapKey } = await derivePairingKeys(secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    relationshipKeyCommitment,
  ]));
  try {
    const provider = await aesProvider();
    const plaintext = await provider.decrypt({
      iv: base64ToBytes(fields[1] ?? ''),
      ciphertext: base64ToBytes(fields[2] ?? ''),
      tag: base64ToBytes(fields[3] ?? ''),
    }, wrapKey, aad);
    return normalizeRelationshipKeyLocal(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Pairing handoff is invalid.');
  }
}

export async function createPairingConfirmation(
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const { confirmKey } = await derivePairingKeys(secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    'confirmation',
  ]));
  const provider = await aesProvider();
  const parts = await provider.encrypt(CONFIRMATION_TEXT, confirmKey, aad);
  return [
    PAIRING_HANDSHAKE_VERSION,
    bytesToBase64(parts.iv),
    bytesToBase64(parts.ciphertext),
    bytesToBase64(parts.tag),
  ].join('.');
}

export async function verifyPairingConfirmation(
  envelope: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<void> {
  const fields = envelope.split('.');
  if (fields.length !== 4 || fields[0] !== PAIRING_HANDSHAKE_VERSION) {
    throw new Error('Pairing confirmation is invalid.');
  }
  const { confirmKey } = await derivePairingKeys(secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    'confirmation',
  ]));
  try {
    const provider = await aesProvider();
    const plaintext = await provider.decrypt({
      iv: base64ToBytes(fields[1] ?? ''),
      ciphertext: base64ToBytes(fields[2] ?? ''),
      tag: base64ToBytes(fields[3] ?? ''),
    }, confirmKey, aad);
    if (plaintext.length !== CONFIRMATION_TEXT.length) throw new Error();
    for (let index = 0; index < plaintext.length; index += 1) {
      if (plaintext[index] !== CONFIRMATION_TEXT[index]) throw new Error();
    }
  } catch {
    throw new Error('Pairing confirmation is invalid.');
  }
}
