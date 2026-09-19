import { AESEncryptionKey } from 'expo-crypto';
import { base64ToBytes, bytesToBase64 } from './encoding.ts';

export const RELATIONSHIP_KEY_BYTES = 32;

export async function generateRelationshipKey(): Promise<string> {
  const key = await AESEncryptionKey.generate(256);
  return key.encoded('base64');
}

export async function normalizeRelationshipKey(value: string): Promise<string> {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Relationship encryption key is invalid.');
  }
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length !== RELATIONSHIP_KEY_BYTES) throw new Error();
    return bytesToBase64(bytes);
  } catch {
    throw new Error('Relationship encryption key is invalid.');
  }
}
