import type { PairingAcceptResponse, PairingBootstrapResponse } from './protocol';
import { CloudClient } from './CloudClient';
import { CloudIdentityStore, type CloudIdentity, type PendingPairing } from './CloudIdentityStore';
import { createPairingPackage, decodePairingPackage, isValidPairingConfirmationCode, relationshipKeyCommitment } from './pairing';
import { generateRelationshipKey } from '../crypto/relationshipKey';

export interface PairingManagerOptions {
  cloud: CloudClient;
  identityStore: CloudIdentityStore;
  keyGenerator?: () => Promise<string>;
  keyCommitment?: (relationshipKey: string) => Promise<string>;
  now?: () => number;
}

export interface PendingPairingView {
  relationshipId: string;
  invitationId: string;
  confirmationCode: string;
  expiresAt: number;
  package: string;
}

export interface PairingAcceptResult {
  identity: CloudIdentity;
  response: PairingAcceptResponse;
}

export class PairingManager {
  private readonly cloud: CloudClient;
  private readonly identityStore: CloudIdentityStore;
  private readonly keyGenerator: () => Promise<string>;
  private readonly keyCommitment: (relationshipKey: string) => Promise<string>;
  private readonly now: () => number;

  constructor(options: PairingManagerOptions) {
    this.cloud = options.cloud;
    this.identityStore = options.identityStore;
    this.keyGenerator = options.keyGenerator ?? generateRelationshipKey;
    this.keyCommitment = options.keyCommitment ?? relationshipKeyCommitment;
    this.now = options.now ?? Date.now;
  }

  async startPairing(expiresInSeconds?: number): Promise<PendingPairingView> {
    const existing = await this.identityStore.load();
    if (existing) throw new Error('A cloud identity already exists on this device.');

    const relationshipKey = await this.keyGenerator();
    const commitment = await this.keyCommitment(relationshipKey);
    const response = await this.cloud.bootstrapPairing({
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
      relationshipKeyCommitment: commitment,
    });
    if (response.relationshipKeyCommitment !== commitment) {
      throw new Error('Cloud returned a different relationship key commitment.');
    }

    const pendingPairing: PendingPairing = {
      invitationId: response.invitationId,
      token: response.token,
      confirmationCode: response.confirmationCode,
      expiresAt: response.expiresAt,
    };
    const identity: CloudIdentity = {
      relationshipId: response.relationshipId,
      deviceId: response.deviceId,
      participant: 'ME',
      state: 'PAIRING',
      credential: response.credential,
      relationshipKey,
      pendingPairing,
    };
    const pairingPackage = await createPairingPackage(response, relationshipKey);
    await this.identityStore.save(identity);
    this.cloud.setCredential(response.credential);

    return {
      relationshipId: response.relationshipId,
      invitationId: response.invitationId,
      confirmationCode: response.confirmationCode,
      expiresAt: response.expiresAt,
      package: pairingPackage,
    };
  }

  async resumePendingPairing(): Promise<PendingPairingView | null> {
    const identity = await this.identityStore.load();
    if (!identity || identity.state !== 'PAIRING' || !identity.pendingPairing) return null;
    if (identity.pendingPairing.expiresAt <= this.now()) {
      await this.identityStore.clear();
      this.cloud.clearCredential();
      return null;
    }

    const response: PairingBootstrapResponse = {
      relationshipId: identity.relationshipId,
      invitationId: identity.pendingPairing.invitationId,
      deviceId: identity.deviceId,
      participant: 'ME',
      credential: identity.credential,
      token: identity.pendingPairing.token,
      confirmationCode: identity.pendingPairing.confirmationCode,
      relationshipKeyCommitment: await this.keyCommitment(identity.relationshipKey),
      expiresAt: identity.pendingPairing.expiresAt,
    };

    this.cloud.setCredential(identity.credential);
    return {
      relationshipId: identity.relationshipId,
      invitationId: identity.pendingPairing.invitationId,
      confirmationCode: identity.pendingPairing.confirmationCode,
      expiresAt: identity.pendingPairing.expiresAt,
      package: await createPairingPackage(response, identity.relationshipKey),
    };
  }

  async acceptPairingPackage(encodedPackage: string, confirmationCode: string): Promise<PairingAcceptResult> {
    if (!isValidPairingConfirmationCode(confirmationCode)) throw new Error('Pairing confirmation must contain exactly five valid emojis.');
    const pairingPackage = await decodePairingPackage(encodedPackage);
    const commitment = await this.keyCommitment(pairingPackage.relationshipKey);

    const existing = await this.identityStore.load();
    if (existing) throw new Error('A cloud identity already exists on this device.');

    const response = await this.cloud.acceptInvitation(pairingPackage.token, confirmationCode, commitment);
    if (response.relationshipId !== pairingPackage.relationshipId) throw new Error('Cloud returned a different relationship ID.');
    if (response.relationshipKeyCommitment !== commitment) throw new Error('Cloud returned a different relationship key commitment.');

    const identity: CloudIdentity = {
      relationshipId: response.relationshipId,
      deviceId: response.deviceId,
      participant: 'PARTNER',
      state: 'ACTIVE',
      credential: response.credential,
      relationshipKey: pairingPackage.relationshipKey,
    };
    await this.identityStore.save(identity);
    this.cloud.setCredential(response.credential);
    return { identity, response };
  }

  async refreshRelationshipState(): Promise<CloudIdentity | null> {
    const identity = await this.identityStore.load();
    if (!identity) return null;
    this.cloud.setCredential(identity.credential);

    const probe = await this.cloud.authProbe();
    if (probe.relationshipStatus === 'ENDED') {
      await this.identityStore.clear();
      this.cloud.clearCredential();
      return null;
    }

    if (identity.participant === 'ME' && identity.state === 'ACTIVE' && probe.relationshipStatus === 'PAIRING') {
      throw new Error('Cloud relationship state regressed to pairing.');
    }

    const nextState = probe.relationshipStatus === 'ACTIVE' ? 'ACTIVE' : 'PAIRING';
    if (identity.state === nextState) return identity;

    if (nextState === 'PAIRING' && !identity.pendingPairing) {
      throw new Error('Cloud reports pairing without a recoverable pending invitation.');
    }

    const updated: CloudIdentity = {
      ...identity,
      state: nextState,
      pendingPairing: nextState === 'ACTIVE' ? undefined : identity.pendingPairing,
    };
    await this.identityStore.save(updated);
    return updated;
  }
}
