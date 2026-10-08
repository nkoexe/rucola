import { normalizeRelationshipKey } from '../crypto/relationshipKey.ts';

export { isValidPairingConfirmationCode } from './pairingCode.ts';

export async function relationshipKeyCommitment(relationshipKey: string): Promise<string> {
  const normalized = await normalizeRelationshipKey(relationshipKey);
  const value = new TextEncoder().encode('rucola-e2e-key-v1:' + normalized);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', value);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const { CryptoDigestAlgorithm, digestStringAsync } = await import('expo-crypto');
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, 'rucola-e2e-key-v1:' + normalized);
}
