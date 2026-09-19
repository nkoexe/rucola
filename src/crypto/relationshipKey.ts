import { AESEncryptionKey } from 'expo-crypto';

export const RELATIONSHIP_KEY_BYTES = 32;

export async function generateRelationshipKey(): Promise<string> {
  const key = await AESEncryptionKey.generate(256);
  return key.encoded('base64');
}

export async function normalizeRelationshipKey(value: string): Promise<string> {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Relationship encryption key is invalid.');
  }

  const key = await AESEncryptionKey.import(value, 'base64');
  if (key.size !== 256) throw new Error('Relationship encryption key must be 256 bits.');
  return key.encoded('base64');
}
