import { base64ToBytes } from '../crypto/encoding';
import { isValidPairingConfirmationCode } from './pairingCode';

export type CloudParticipant = 'ME' | 'PARTNER';
export type CloudRelationshipState = 'PAIRING' | 'ACTIVE';

export interface PendingPairing {
  invitationId: string;
  token: string;
  confirmationCode: string;
  expiresAt: number;
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
  if (
    typeof candidate.invitationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.invitationId) ||
    typeof candidate.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate.token) ||
    typeof candidate.confirmationCode !== 'string' || !isValidPairingConfirmationCode(candidate.confirmationCode) ||
    !Number.isSafeInteger(candidate.expiresAt) || (candidate.expiresAt as number) <= 0
  ) throw new CloudIdentityStoreError('Stored pairing state is invalid.');
  return {
    invitationId: candidate.invitationId,
    token: candidate.token,
    confirmationCode: candidate.confirmationCode,
    expiresAt: candidate.expiresAt,
  };
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
  return {
    relationshipId: requireId(candidate.relationshipId, 'Relationship ID'),
    deviceId: requireId(candidate.deviceId, 'Device ID'),
    participant,
    state,
    credential: requireCredential(candidate.credential),
    relationshipKey: requireKey(candidate.relationshipKey),
    pendingPairing,
  };
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
