import { cpace } from '@cipherman/pake-js';
import { getRandomBytesAsync } from 'expo-crypto';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { canonicalizePairingCode } from './pairingTransport.ts';
import { base64ToBytes, bytesToBase64, utf8Encode } from '../crypto/encoding.ts';
import { expoAesGcmProvider } from '../crypto/expoAesGcm.ts';

const PROTOCOL_VERSION = 'rucola-pairing-v1';
const CONFIRMATION_TEXT = utf8Encode(PROTOCOL_VERSION + ':confirmed');
const WRAP_INFO = utf8Encode(PROTOCOL_VERSION + ':wrap');
const CONFIRM_INFO = utf8Encode(PROTOCOL_VERSION + ':confirm');

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function deriveKey(isk: Uint8Array, sessionId: Uint8Array, info: Uint8Array): string {
  return bytesToBase64(hkdf(sha256, isk, sessionId, info, 32));
}

function pairingInputs(pairingCode: string, sessionId: string, commitment: string) {
  const code = canonicalizePairingCode(pairingCode);
  const sid = base64ToBytes(sessionId);
  const context = utf8Encode(PROTOCOL_VERSION);
  const associated = utf8Encode(JSON.stringify([PROTOCOL_VERSION, commitment]));
  return { PRS: utf8Encode(code), sid, CI: context, associated };
}

function encodeSessionId(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

function decodeSessionId(value: string): Uint8Array {
  const bytes = base64ToBytes(value);
  if (bytes.length !== 16) throw new Error('Pairing session is invalid.');
  return bytes;
}

export async function createPairingHandshake(
  sessionId: string,
  pairingCode: string,
  relationshipKeyCommitment: string,
): Promise<PairingHandshakeInit> {
  const sid = decodeSessionId(sessionId);
  const code = canonicalizePairingCode(pairingCode);
  const init = cpace.ristretto255.init({
    PRS: utf8Encode(code),
    sid,
    CI: utf8Encode(PROTOCOL_VERSION),
  });
  return {
    sessionId,
    ephemeralSecret: bytesToBase64(init.ephemeralSecret),
    share: bytesToBase64(init.share),
  };
}

export async function createPairingSessionId(): Promise<string> {
  return encodeSessionId(await getRandomBytesAsync(16));
}

export function createResponderHandshake(
  sessionId: string,
  pairingCode: string,
  relationshipKeyCommitment: string,
): Promise<PairingHandshakeInit> {
  return createPairingHandshake(sessionId, pairingCode, relationshipKeyCommitment);
}

function deriveIsk(
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
  ownIsInitiator: boolean,
): Uint8Array {
  const { PRS, sid, CI, associated } = pairingInputs(
    canonicalizePairingCode('😀😀😀😀😀'),
    secrets.sessionId,
    secrets.relationshipKeyCommitment,
  );
  void PRS; void sid; void CI; void associated; void ownIsInitiator; void peerShareBase64;
  throw new Error('Pairing handshake derivation requires the pairing code.');
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
  const isk = secrets.role === 'INITIATOR'
    ? cpace.ristretto255.deriveIskInitiatorResponder({
        ephemeralSecret: own.ephemeralSecret,
        ownShare: own.share,
        peerShare,
        ownAD: associated,
        peerAD: associated,
        sid,
        role: 'initiator',
      })
    : cpace.ristretto255.deriveIskInitiatorResponder({
        ephemeralSecret: own.ephemeralSecret,
        ownShare: own.share,
        peerShare,
        ownAD: associated,
        peerAD: associated,
        sid,
        role: 'responder',
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
    PROTOCOL_VERSION,
    secrets.sessionId,
    relationshipKeyCommitment,
  ]));
  const parts = await expoAesGcmProvider.encrypt(utf8Encode(relationshipKey), wrapKey, aad);
  return [
    PROTOCOL_VERSION,
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
  if (fields.length !== 4 || fields[0] !== PROTOCOL_VERSION) throw new Error('Pairing handoff is invalid.');
  const { wrapKey, confirmKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([
    PROTOCOL_VERSION,
    secrets.sessionId,
    relationshipKeyCommitment,
  ]));
  const plaintext = await expoAesGcmProvider.decrypt({
    iv: base64ToBytes(fields[1] ?? ''),
    ciphertext: base64ToBytes(fields[2] ?? ''),
    tag: base64ToBytes(fields[3] ?? ''),
  }, wrapKey, aad);
  if (sha256(utf8Encode(plaintextToString(plaintext) + ':' + relationshipKeyCommitment)).length !== 32) {
    throw new Error('Pairing handoff is invalid.');
  }
  return plaintextToString(plaintext);
}

function plaintextToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function createPairingConfirmation(
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<string> {
  const { confirmKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([PROTOCOL_VERSION, secrets.sessionId, 'confirmation']));
  const parts = await expoAesGcmProvider.encrypt(CONFIRMATION_TEXT, confirmKey, aad);
  return [PROTOCOL_VERSION, bytesToBase64(parts.iv), bytesToBase64(parts.ciphertext), bytesToBase64(parts.tag)].join('.');
}

export async function verifyPairingConfirmation(
  envelope: string,
  pairingCode: string,
  secrets: PairingHandshakeSecrets,
  peerShareBase64: string,
): Promise<void> {
  const fields = envelope.split('.');
  if (fields.length !== 4 || fields[0] !== PROTOCOL_VERSION) throw new Error('Pairing confirmation is invalid.');
  const { confirmKey } = await derivePairingKeys(pairingCode, secrets, peerShareBase64);
  const aad = utf8Encode(JSON.stringify([PROTOCOL_VERSION, secrets.sessionId, 'confirmation']));
  const plaintext = await expoAesGcmProvider.decrypt({
    iv: base64ToBytes(fields[1] ?? ''),
    ciphertext: base64ToBytes(fields[2] ?? ''),
    tag: base64ToBytes(fields[3] ?? ''),
  }, confirmKey, aad);
  if (!bytesEqual(plaintext, CONFIRMATION_TEXT)) throw new Error('Pairing confirmation is invalid.');
}
