import { base64ToBytes, bytesToBase64 } from './encoding.ts';

export const RELATIONSHIP_KEY_BYTES = 32;

function hasBrowserWebCrypto(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof globalThis.crypto?.subtle !== 'undefined'
  );
}

async function generateWebRelationshipKey(): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is unavailable on this device.');
  }

  const key = await subtle.generateKey(
    { name: 'AES-GCM', length: RELATIONSHIP_KEY_BYTES * 8 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
}

export async function generateRelationshipKey(): Promise<string> {
  if (hasBrowserWebCrypto()) {
    return generateWebRelationshipKey();
  }

  const { AESEncryptionKey } = await import('expo-crypto');
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
