import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { normalizeRelationshipKey } from '../crypto/relationshipKey.ts';

export { isValidPairingConfirmationCode } from './pairingCode.ts';

export async function relationshipKeyCommitment(relationshipKey: string): Promise<string> {
  const normalized = await normalizeRelationshipKey(relationshipKey);
  return digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    'rucola-e2e-key-v1:' + normalized,
  );
}

