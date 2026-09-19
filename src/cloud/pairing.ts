import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { type PairingPackage } from './pairingPackage';
export { PAIRING_PROTOCOL_VERSION, createPairingPackage, decodePairingPackage, type PairingPackage } from './pairingPackage';
import type { PairingPackage } from './pairingPackage';
import { normalizeRelationshipKey } from '../crypto/relationshipKey';

export { isValidPairingConfirmationCode } from './pairingCode';

export async function relationshipKeyCommitment(relationshipKey: string): Promise<string> {
  const normalized = await normalizeRelationshipKey(relationshipKey);
  return digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    'rucola-e2e-key-v1:' + normalized,
  );
}

export async function assertPairingPackageMatchesCommitment(pkg: PairingPackage, commitment: string): Promise<void> {
  const actual = await relationshipKeyCommitment(pkg.relationshipKey);
  if (actual !== commitment) throw new Error('Pairing package does not match the server key commitment.');
}