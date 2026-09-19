import { base64ToBytes } from '../crypto/encoding';

export type CloudParticipant = 'ME' | 'PARTNER';

export interface CloudIdentity {
  relationshipId: string;
  deviceId: string;
  participant: CloudParticipant;
  credential: string;
  relationshipKey: string;
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

function parseIdentity(value: unknown): CloudIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CloudIdentityStoreError();
  const candidate = value as Record<string, unknown>;
  const participant = candidate.participant;
  if (participant !== 'ME' && participant !== 'PARTNER') throw new CloudIdentityStoreError('Stored cloud participant is invalid.');
  return {
    relationshipId: requireId(candidate.relationshipId, 'Relationship ID'),
    deviceId: requireId(candidate.deviceId, 'Device ID'),
    participant,
    credential: requireCredential(candidate.credential),
    relationshipKey: requireKey(candidate.relationshipKey),
  };
}

export class CloudIdentityStore {
  private readonly store: SecureValueStore;

  constructor(store: SecureValueStore) {
    this.store = store;
  }

  async load(): Promise<CloudIdentity | null> {
    const value = await this.store.getItem(STORAGE_KEY);
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
    await this.store.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }

  async clear(): Promise<void> {
    await this.store.deleteItem(STORAGE_KEY);
  }
}

export { STORAGE_KEY as CLOUD_IDENTITY_STORAGE_KEY };
