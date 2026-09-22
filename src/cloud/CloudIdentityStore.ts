import { base64ToBytes } from '../crypto/encoding.ts';
import { isValidPairingConfirmationCode } from './pairingCode.ts';

export type CloudParticipant = 'ME' | 'PARTNER';
export type CloudRelationshipState = 'PAIRING' | 'ACTIVE';

export interface PendingPairingHandshake {
  sessionId: string;
  ephemeralSecret: string;
  ownShare: string;
}

export interface PendingPairing {
  invitationId: string;
  token: string;
  confirmationCode: string;
  expiresAt: number;
  handshake?: PendingPairingHandshake;
}

export interface CloudIdentity {
  relationshipId: string;
  deviceId: string;
  participant: CloudParticipant;
  state: CloudRelationshipState;
  credential: string;
  relationshipKey: string;
  pendingPairing?: PendingPairing;
}

export interface SecureValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export class CloudIdentityStoreError extends Error {
  constructor(message = 'Stored cloud identity is invalid.') {
    super(message);
    this.name = 'CloudIdentityStoreError';
  }
}

const STORAGE_KEY = 'rucola.cloud.identity.v1';

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new CloudIdentityStoreError(label + ' is invalid.');
  }
  return value;
}

function requireCredential(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new CloudIdentityStoreError('Cloud credential is invalid.');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) throw new CloudIdentityStoreError('Relationship encryption key is invalid.');
  try {
    if (base64ToBytes(value).length !== 32) throw new Error();
  } catch {
    throw new CloudIdentityStoreError('Relationship encryption key is invalid.');
  }
  return value;
}

function parsePendingPairing(value: unknown): PendingPairing {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CloudIdentityStoreError('Stored pairing state is invalid.');
  const candidate = value as Record<string, unknown>;
  const invitationId = candidate.invitationId;
  const token = candidate.token;
  const confirmationCode = candidate.confirmationCode;
  const expiresAt = candidate.expiresAt;
  const handshakeValue = candidate.handshake;
  let handshake: PendingPairingHandshake | undefined;
  if (handshakeValue !== undefined) {
    if (handshakeValue === null || typeof handshakeValue !== 'object' || Array.isArray(handshakeValue)) {
      throw new CloudIdentityStoreError('Stored pairing handshake is invalid.');
    }
    const candidateHandshake = handshakeValue as Record<string, unknown>;
    const sessionId = candidateHandshake.sessionId;
    const ephemeralSecret = candidateHandshake.ephemeralSecret;
    const ownShare = candidateHandshake.ownShare;
    if (
      typeof sessionId !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==)$/.test(sessionId) ||
      (() => { try { return base64ToBytes(sessionId).length !== 16; } catch { return true; } })() ||
      typeof ephemeralSecret !== 'string' ||
      (() => { try { return base64ToBytes(ephemeralSecret).length !== 32; } catch { return true; } })() ||
      typeof ownShare !== 'string' ||
      (() => { try { return base64ToBytes(ownShare).length !== 32; } catch { return true; } })()
    ) throw new CloudIdentityStoreError('Stored pairing handshake is invalid.');
    handshake = { sessionId, ephemeralSecret, ownShare };
  }
  if (
    typeof invitationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(invitationId) ||
    typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    typeof confirmationCode !== 'string' || !isValidPairingConfirmationCode(confirmationCode) ||
    !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= 0
  ) throw new CloudIdentityStoreError('Stored pairing state is invalid.');
  return handshake === undefined
    ? { invitationId, token, confirmationCode, expiresAt: expiresAt as number }
    : { invitationId, token, confirmationCode, expiresAt: expiresAt as number, handshake };
}

function parseIdentity(value: unknown): CloudIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CloudIdentityStoreError();
  const candidate = value as Record<string, unknown>;
  const participant = candidate.participant;
  const state = candidate.state;
  if (participant !== 'ME' && participant !== 'PARTNER') throw new CloudIdentityStoreError('Stored cloud participant is invalid.');
  if (state !== 'PAIRING' && state !== 'ACTIVE') throw new CloudIdentityStoreError('Stored cloud relationship state is invalid.');
  const pendingPairing = candidate.pendingPairing === undefined ? undefined : parsePendingPairing(candidate.pendingPairing);
  if (state === 'PAIRING' && !pendingPairing) throw new CloudIdentityStoreError('Stored pairing state is missing.');
  if (state === 'ACTIVE' && pendingPairing) throw new CloudIdentityStoreError('Active cloud identity cannot have pending pairing state.');
  const identity: CloudIdentity = {
    relationshipId: requireId(candidate.relationshipId, 'Relationship ID'),
    deviceId: requireId(candidate.deviceId, 'Device ID'),
    participant,
    state,
    credential: requireCredential(candidate.credential),
    relationshipKey: requireKey(candidate.relationshipKey),
  };
  return pendingPairing === undefined ? identity : { ...identity, pendingPairing };
}

export class CloudIdentityStore {
  private readonly store: SecureValueStore;
  private readonly storageKey: string;

  constructor(store: SecureValueStore, storageKey = STORAGE_KEY) {
    if (!storageKey || storageKey.length > 128) throw new Error('Cloud identity storage key is invalid.');
    this.store = store;
    this.storageKey = storageKey;
  }

  async load(): Promise<CloudIdentity | null> {
    const value = await this.store.getItem(this.storageKey);
    if (value === null) return null;

    try {
      return parseIdentity(JSON.parse(value) as unknown);
    } catch (cause) {
      if (cause instanceof CloudIdentityStoreError) throw cause;
      throw new CloudIdentityStoreError();
    }
  }

  async save(identity: CloudIdentity): Promise<void> {
    const normalized = parseIdentity(identity);
    await this.store.setItem(this.storageKey, JSON.stringify(normalized));
  }

  async clear(): Promise<void> {
    await this.store.deleteItem(this.storageKey);
  }
}

export { STORAGE_KEY as CLOUD_IDENTITY_STORAGE_KEY };
