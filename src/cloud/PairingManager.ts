import type { PairingAcceptResponse, PairingBootstrapResponse } from './protocol.ts';
import { CloudClient } from './CloudClient.ts';
import { CloudIdentityStore, type CloudIdentity, type PendingPairing } from './CloudIdentityStore.ts';
import { createPairingPackage, decodePairingPackage } from './pairingPackage.ts';
import { isValidPairingConfirmationCode } from './pairingCode.ts';
import {
  createPairingShareUrl,
  normalizePairingInput,
  type PairingInput,
  type PairingInvitationView,
} from './pairingTransport.ts';

export type { PairingInput, PairingInvitationView };

export interface PairingManagerOptions {
  cloud: CloudClient;
  identityStore: CloudIdentityStore;
  keyGenerator?: () => Promise<string>;
  keyCommitment?: (relationshipKey: string) => Promise<string>;
  now?: () => number;
}

/**
 * Transitional compatibility view for the package-based pairing path.
 * New code should use PairingInvitationView instead.
 */
export interface PendingPairingView {
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
    this.keyGenerator = options.keyGenerator ?? (async () => {
      const { generateRelationshipKey } = await import('../crypto/relationshipKey.ts');
      return generateRelationshipKey();
    });
    this.keyCommitment = options.keyCommitment ?? (async (relationshipKey) => {
      const { relationshipKeyCommitment } = await import('./pairing.ts');
      return relationshipKeyCommitment(relationshipKey);
    });
    this.now = options.now ?? Date.now;
  }

  /**
   * Transitional compatibility API. New code should call startPairingInvitation().
   */
  async startPairing(expiresInSeconds?: number): Promise<PendingPairingView> {
    const pending = await this.createPendingPairing(expiresInSeconds);
    return this.toLegacyPendingView(pending.response, pending.relationshipKey);
  }

  async startPairingInvitation(expiresInSeconds?: number): Promise<PairingInvitationView> {
    const pending = await this.createPendingPairing(expiresInSeconds);
    return this.toInvitationView(pending.response.confirmationCode, pending.response.expiresAt);
  }

  /**
   * Transitional compatibility API. New code should call resumePendingPairingInvitation().
   */
  async resumePendingPairing(): Promise<PendingPairingView | null> {
    const pending = await this.loadPendingPairing();
    if (!pending) return null;
    return this.toLegacyPendingView(pending.response, pending.identity.relationshipKey);
  }

  async resumePendingPairingInvitation(): Promise<PairingInvitationView | null> {
    const pending = await this.loadPendingPairing();
    return pending ? this.toInvitationView(pending.response.confirmationCode, pending.response.expiresAt) : null;
  }

  normalizePairingInput(input: PairingInput): { transport: 'EMOJI' | 'SHARE_LINK'; pairingCode: string } {
    return normalizePairingInput(input);
  }

  async acceptPairingPackage(encodedPackage: string, confirmationCode: string): Promise<PairingAcceptResult> {
    if (!isValidPairingConfirmationCode(confirmationCode)) {
      throw new Error('Pairing confirmation must contain exactly five valid emojis.');
    }

    const pairingPackage = await decodePairingPackage(encodedPackage);
    const commitment = await this.keyCommitment(pairingPackage.relationshipKey);

    const existing = await this.identityStore.load();
    if (existing) throw new Error('A cloud identity already exists on this device.');

    const response = await this.cloud.acceptInvitation(pairingPackage.token, confirmationCode, commitment);
    if (response.relationshipKeyCommitment !== commitment) {
      throw new Error('Cloud returned a different relationship key commitment.');
    }

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

  async cancelPendingPairing(): Promise<void> {
    const identity = await this.identityStore.load();
    if (!identity || identity.state !== 'PAIRING') return;
    await this.identityStore.clear();
    this.cloud.clearCredential();
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

  private async createPendingPairing(expiresInSeconds?: number): Promise<{
    response: PairingBootstrapResponse;
    relationshipKey: string;
  }> {
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

    const identity: CloudIdentity = {
      relationshipId: response.relationshipId,
      deviceId: response.deviceId,
      participant: 'ME',
      state: 'PAIRING',
      credential: response.credential,
      relationshipKey,
      pendingPairing: {
        invitationId: response.invitationId,
        token: response.token,
        confirmationCode: response.confirmationCode,
        expiresAt: response.expiresAt,
      },
    };

    await this.identityStore.save(identity);
    this.cloud.setCredential(response.credential);

    return { response, relationshipKey };
  }

  private async loadPendingPairing(): Promise<{
    response: PairingBootstrapResponse;
    identity: CloudIdentity;
  } | null> {
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
    return { response, identity };
  }

  private toInvitationView(pairingCode: string, expiresAt: number): PairingInvitationView {
    return {
      pairingCode,
      shareUrl: createPairingShareUrl(pairingCode),
      expiresAt,
    };
  }

  private async toLegacyPendingView(
    response: PairingBootstrapResponse,
    relationshipKey: string,
  ): Promise<PendingPairingView> {
    return {
      confirmationCode: response.confirmationCode,
      expiresAt: response.expiresAt,
      package: await createPairingPackage(response, relationshipKey),
    };
  }
}
