import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, getRandomBytesAsync } from 'expo-crypto';

export interface AesGcmParts {
  iv: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

export interface AesGcmProvider {
  encrypt(plaintext: Uint8Array, keyBase64: string, additionalData: Uint8Array): Promise<AesGcmParts>;
  decrypt(parts: AesGcmParts, keyBase64: string, additionalData: Uint8Array): Promise<Uint8Array>;
}

async function importKey(keyBase64: string): Promise<AESEncryptionKey> {
  const key = await AESEncryptionKey.import(keyBase64, 'base64');
  if (key.size !== 256) throw new Error('Relationship encryption key must be 256 bits.');
  return key;
}

export const expoAesGcmProvider: AesGcmProvider = {
  async encrypt(plaintext, keyBase64, additionalData) {
    const key = await importKey(keyBase64);
    const nonce = await getRandomBytesAsync(12);
    const sealed = await aesEncryptAsync(plaintext, key, {
      nonce: { bytes: nonce },
      additionalData,
      tagLength: 16,
    });

    return {
      iv: await sealed.iv('bytes'),
      ciphertext: await sealed.ciphertext({ encoding: 'bytes', includeTag: false }),
      tag: await sealed.tag('bytes'),
    };
  },

  async decrypt(parts, keyBase64, additionalData) {
    const key = await importKey(keyBase64);
    const sealed = AESSealedData.fromParts(parts.iv, parts.ciphertext, parts.tag);
    return aesDecryptAsync(sealed, key, { output: 'bytes', additionalData });
  },
};
