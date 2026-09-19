import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { base64UrlToBytes, bytesToBase64Url, utf8Decode, utf8Encode } from '../crypto/encoding';
import { normalizeRelationshipKey } from '../crypto/relationshipKey';
import type { PairingBootstrapResponse } from './protocol';

export const PAIRING_PROTOCOL_VERSION = 1;
const PACKAGE_PREFIX = 'rucola-pairing:v1.';
const MAX_PACKAGE_LENGTH = 16 * 1024;

export const PAIRING_EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
  '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪',
  '😎', '🤩', '🥳', '🤗', '🤔', '🥺', '😭', '😡',
  '😴',
] as const;

export interface PairingPackage {
  version: typeof PAIRING_PROTOCOL_VERSION;
  relationshipId: string;
  invitationId: string;
  token: string;
  expiresAt: number;
  relationshipKey: string;
}

export function isValidPairingConfirmationCode(value: string): boolean {
  return Array.from(value).length === 5 && Array.from(value).every((emoji) => (PAIRING_EMOJIS as readonly string[]).includes(emoji));
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(label + ' is invalid.');
}

function assertToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Pairing token is invalid.');
}

function assertExpiry(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || value <= Date.now()) throw new Error('Pairing package is expired or invalid.');
}

function encodeJson(value: unknown): string {
  return bytesToBase64Url(utf8Encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  return JSON.parse(utf8Decode(base64UrlToBytes(value)));
}

export async function relationshipKeyCommitment(relationshipKey: string): Promise<string> {
  const normalized = await normalizeRelationshipKey(relationshipKey);
  return digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    'rucola-e2e-key-v1:' + normalized,
  );
}

export async function createPairingPackage(response: PairingBootstrapResponse, relationshipKey: string): Promise<string> {
  const normalizedKey = await normalizeRelationshipKey(relationshipKey);
  assertIdentifier(response.relationshipId, 'Relationship ID');
  assertIdentifier(response.invitationId, 'Invitation ID');
  assertIdentifier(response.deviceId, 'Device ID');
  assertToken(response.token);
  assertExpiry(response.expiresAt);

  const payload: PairingPackage = {
    version: PAIRING_PROTOCOL_VERSION,
    relationshipId: response.relationshipId,
    invitationId: response.invitationId,
    token: response.token,
    expiresAt: response.expiresAt,
    relationshipKey: normalizedKey,
  };
  const encoded = PACKAGE_PREFIX + encodeJson(payload);
  if (encoded.length > MAX_PACKAGE_LENGTH) throw new Error('Pairing package is too large.');
  return encoded;
}

export async function decodePairingPackage(value: string): Promise<PairingPackage> {
  if (typeof value !== 'string' || !value.startsWith(PACKAGE_PREFIX) || value.length > MAX_PACKAGE_LENGTH) {
    throw new Error('Pairing package is invalid.');
  }

  try {
    const payload = decodeJson(value.slice(PACKAGE_PREFIX.length));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    const candidate = payload as Record<string, unknown>;
    if (candidate.version !== PAIRING_PROTOCOL_VERSION) throw new Error();
    assertIdentifier(candidate.relationshipId, 'Relationship ID');
    assertIdentifier(candidate.invitationId, 'Invitation ID');
    assertToken(candidate.token);
    assertExpiry(candidate.expiresAt);
    if (typeof candidate.relationshipKey !== 'string') throw new Error();
    const relationshipKey = await normalizeRelationshipKey(candidate.relationshipKey);
    return {
      version: PAIRING_PROTOCOL_VERSION,
      relationshipId: candidate.relationshipId,
      invitationId: candidate.invitationId,
      token: candidate.token,
      expiresAt: candidate.expiresAt,
      relationshipKey,
    };
  } catch {
    throw new Error('Pairing package is invalid.');
  }
}

export async function assertPairingPackageMatchesCommitment(pkg: PairingPackage, commitment: string): Promise<void> {
  const actual = await relationshipKeyCommitment(pkg.relationshipKey);
  if (actual !== commitment) throw new Error('Pairing package does not match the server key commitment.');
}
