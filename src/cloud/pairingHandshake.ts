import { cpace } from '@cipherman/pake-js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { canonicalizePairingCode } from './pairingTransport.ts';
import { base64ToBytes, bytesToBase64, utf8Encode } from '../crypto/encoding.ts';
import { expoAesGcmProvider } from '../crypto/expoAesGcm.ts';

export const PAIRING_HANDSHAKE_VERSION = 'rucola-pairing-v1';
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

function deriveKey(isk: Uint8Array, sessionId: Uint8Array, info: Uint8Array): string {
  return bytesToBase64(hkdf(sha256, isk, sessionId, info, 32));
}

function pairingInputs(pairingCode: string, sessionId: string, relationshipKeyCommitment: string) {
  const code = canonicalizePairingCode(pairingCode);
  const sid = base64ToBytes(sessionId);
  if (sid.length !== 16) throw new Error('Pairing session is invalid.');
  const associated = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    relationshipKeyCommitment,
  ]));
  return {
    PRS: utf8Encode(code),
    sid,
    CI: utf8Encode(PAIRING_HANDSHAKE_VERSION),
    associated,
  };
}

export function createPairingHandshake(
  sessionId: string,
  pairingCode: string,
  _relationshipKeyCommitment: string,
): PairingHandshakeInit {
  const { PRS, sid, CI } = pairingInputs(pairingCode, sessionId, _relationshipKeyCommitment);
  const init = cpace.ristretto255.init({ PRS, sid, CI });
  return {
    sessionId,
    ephemeralSecret: bytesToBase64(init.ephemeralSecret),
    share: bytesToBase64(init.share),
  };
}

export async function createPairingSessionId(): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('Secure randomness is unavailable.');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return bytesToBase64(bytes);
}

export async function derivePairingKeys(
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<{ wrapKey: string; confirmKey: string }> {
  const { PRS, sid, CI, associated } = pairingInputs(
    pairingCode,
    secrets.sessionId,
    secrets.relationshipKeyCommitment,
  );
  const own = {
    ephemeralSecret: base64ToBytes(secrets.ephemeralSecret),
    share: base64ToBytes(secrets.ownShare),
  };
  const peerShare = base64ToBytes(peerShareBase64);
  const isk = cpace.ristretto255.deriveIskInitiatorResponder({
    ephemeralSecret: own.ephemeralSecret,
    ownShare: own.share,
    peerShare,
    ownAD: associated,
    peerAD: associated,
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
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const { wrapKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    relationshipKeyCommitment,
  ]));
  const parts = await expoAesGcmProvider.encrypt(utf8Encode(relationshipKey), wrapKey, aad);
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
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const fields = envelope.split('.');
  if (fields.length !== 4 || fields[0] !== PAIRING_HANDSHAKE_VERSION) throw new Error('Pairing handoff is invalid.');
  const { wrapKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    relationshipKeyCommitment,
  ]));
  const plaintext = await expoAesGcmProvider.decrypt({
    iv: base64ToBytes(fields[1] ?? ''),
    ciphertext: base64ToBytes(fields[2] ?? ''),
    tag: base64ToBytes(fields[3] ?? ''),
  }, wrapKey, aad);
  const relationshipKey = new TextDecoder().decode(plaintext);
  if (!relationshipKey || relationshipKey.length > 512) throw new Error('Pairing handoff is invalid.');
  return relationshipKey;
}

export async function createPairingConfirmation(
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const { confirmKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    'confirmation',
  ]));
  const parts = await expoAesGcmProvider.encrypt(CONFIRMATION_TEXT, confirmKey, aad);
  return [
    PAIRING_HANDSHAKE_VERSION,
    bytesToBase64(parts.iv),
    bytesToBase64(parts.ciphertext),
    bytesToBase64(parts.tag),
  ].join('.');
}

export async function verifyPairingConfirmation(
  envelope: string,
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<void> {
  const fields = envelope.split('.');
  if (fields.length !== 4 || fields[0] !== PAIRING_HANDSHAKE_VERSION) throw new Error('Pairing confirmation is invalid.');
  const { confirmKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PAIRING_HANDSHAKE_VERSION,
    secrets.sessionId,
    'confirmation',
  ]));
  const plaintext = await expoAesGcmProvider.decrypt({
    iv: base64ToBytes(fields[1] ?? ''),
    ciphertext: base64ToBytes(fields[2] ?? ''),
    tag: base64ToBytes(fields[3] ?? ''),
  }, confirmKey, aad);
  if (plaintext.length !== CONFIRMATION_TEXT.length || plaintext.some((value, index) => value !== CONFIRMATION_TEXT[index])) {
    throw new Error('Pairing confirmation is invalid.');
  }
}
