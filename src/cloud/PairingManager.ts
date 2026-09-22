import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from 'expo-crypto';
import type { PairingAcceptResponse, PairingBootstrapResponse } from './protocol.ts';
import { CloudClient, CloudClientError } from './CloudClient.ts';
import { CloudIdentityStore, type CloudIdentity, type PendingPairing } from './CloudIdentityStore.ts';
import {
  createPairingConfirmation,
  createPairingHandshake,
  decryptRelationshipKey,
  derivePairingKeys,
  encryptRelationshipKey,
  generatePairingSessionId,
  type PairingHandshakeSecrets,
} from './pairingHandshake.ts';
import { createPairingPackage, decodePairingPackage } from './pairingPackage.ts';
import { isValidPairingConfirmationCode } from './pairingCode.ts';
import { bytesToBase64Url } from '../crypto/encoding.ts';
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
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
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

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function generatePartnerCredential(): Promise<string> {
  return bytesToBase64Url(await getRandomBytesAsync(32));
}

async function credentialHash(credential: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, credential);
}

export class PairingManager {
  private readonly cloud: CloudClient;
  private readonly identityStore: CloudIdentityStore;
  private readonly keyGenerator: () => Promise<string>;
  private readonly keyCommitment: (relationshipKey: string) => Promise<string>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

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
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new Error('Pairing poll interval is invalid.');
    }
    if (!Number.isSafeInteger(this.maxPollAttempts) || this.maxPollAttempts < 1) {
      throw new Error('Pairing poll attempt count is invalid.');
    }
  }

  async startPairing(expiresInSeconds?: number): Promise<PendingPairingView> {
    const pending = await this.createPendingPairing(expiresInSeconds);
    return this.toLegacyPendingView(pending.response, pending.relationshipKey);
  }

  async startPairingInvitation(expiresInSeconds?: number): Promise<PairingInvitationView> {
    const pending = await this.createPendingPairing(expiresInSeconds);
    await this.ensureInitiatorHandshake(pending.identity);
    return this.toInvitationView(pending.response.confirmationCode, pending.response.expiresAt);
  }

  async resumePendingPairing(): Promise<PendingPairingView | null> {
    const pending = await this.loadPendingPairing();
    if (!pending) return null;
    return this.toLegacyPendingView(pending.response, pending.identity.relationshipKey);
  }

  async resumePendingPairingInvitation(): Promise<PairingInvitationView | null> {
    const pending = await this.loadPendingPairing();
    if (!pending) return null;
    await this.ensureInitiatorHandshake(pending.identity);
    return this.toInvitationView(pending.response.confirmationCode, pending.response.expiresAt);
  }

  normalizePairingInput(input: PairingInput): ReturnType<typeof normalizePairingInput> {
    return normalizePairingInput(input);
  }

  async acceptPairingInput(input: PairingInput): Promise<CloudIdentity> {
    const { pairingCode } = normalizePairingInput(input);
    const existing = await this.identityStore.load();
    if (existing) throw new Error('A cloud identity already exists on this device.');

    const joined = await this.cloud.joinPairingSession(pairingCode);
    const handshake = createPairingHandshake(
      joined.sessionId,
      pairingCode,
      joined.relationshipKeyCommitment,
    );
    const secrets: PairingHandshakeSecrets = {
      sessionId: joined.sessionId,
      ephemeralSecret: handshake.ephemeralSecret,
      ownShare: handshake.share,
      role: 'RESPONDER',
      relationshipKeyCommitment: joined.relationshipKeyCommitment,
    };

    await this.cloud.publishPairingResponderShare(
      joined.sessionId,
      pairingCode,
      handshake.share,
    );

    let partnerCredential: string | null = null;
    let confirmationPublished = false;

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const session = await this.cloud.pollPairingSession(joined.sessionId, pairingCode);

      if (session.relationshipKeyCommitment !== joined.relationshipKeyCommitment) {
        throw new Error('Pairing commitment changed during the handshake.');
      }

      if (session.completed) {
        if (!session.partnerDeviceId) throw new Error('Completed pairing did not return the partner device ID.');
        if (!partnerCredential) throw new Error('Pairing completed before local credential generation.');
        const identity: CloudIdentity = {
          relationshipId: joined.relationshipId,
          deviceId: session.partnerDeviceId,
          participant: 'PARTNER',
          state: 'ACTIVE',
          credential: partnerCredential,
          relationshipKey: await this.relationshipKeyFromSession(
            pairingCode,
            secrets,
            session.responderShare ?? handshake.share,
            session.handoff,
            joined.relationshipKeyCommitment,
          ),
        };
        await this.identityStore.save(identity);
        this.cloud.setCredential(partnerCredential);
        return identity;
      }

      if (!session.responderShare || session.responderShare !== handshake.share) {
        throw new Error('Pairing responder share was not retained by the cloud.');
      }

      if (!session.handoff) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      const relationshipKey = await decryptRelationshipKey(
        session.handoff,
        joined.relationshipKeyCommitment,
        pairingCode,
        secrets,
        session.initiatorShare,
      );
      const actualCommitment = await this.keyCommitment(relationshipKey);
      if (actualCommitment !== joined.relationshipKeyCommitment) {
        throw new Error('Paired relationship key commitment does not match.');
      }

      if (!partnerCredential) {
        partnerCredential = await generatePartnerCredential();
      }

      if (!confirmationPublished) {
        const confirmation = await createPairingConfirmation(
          pairingCode,
          secrets,
          session.initiatorShare,
        );
        const hash = await credentialHash(partnerCredential);
        try {
          await this.cloud.publishPairingConfirmation(
            joined.sessionId,
            pairingCode,
            confirmation,
            hash,
          );
        } catch (cause) {
          if (!(cause instanceof CloudClientError) || cause.code !== 'PAIRING_CONFLICT') {
            throw cause;
          }
        }
        confirmationPublished = true;
      }

      if (session.confirmation && session.completed && session.partnerDeviceId) {
        const identity: CloudIdentity = {
          relationshipId: joined.relationshipId,
          deviceId: session.partnerDeviceId,
          participant: 'PARTNER',
          state: 'ACTIVE',
          credential: partnerCredential,
          relationshipKey,
        };
        await this.identityStore.save(identity);
        this.cloud.setCredential(partnerCredential);
        return identity;
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new Error('Pairing session did not complete before it expired.');
  }

  async completePendingPairing(): Promise<CloudIdentity | null> {
    const pending = await this.loadPendingPairing();
    if (!pending) return null;

    const handshakeState = pending.identity.pendingPairing?.handshake;
    if (!handshakeState) {
      await this.ensureInitiatorHandshake(pending.identity);
    }

    const current = await this.identityStore.load();
    if (!current?.pendingPairing?.handshake) throw new Error('Pending pairing handshake is unavailable.');

    const secrets: PairingHandshakeSecrets = {
      sessionId: current.pendingPairing.handshake.sessionId,
      ephemeralSecret: current.pendingPairing.handshake.ephemeralSecret,
      ownShare: current.pendingPairing.handshake.ownShare,
      role: 'INITIATOR',
      relationshipKeyCommitment: await this.keyCommitment(current.relationshipKey),
    };

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const session = await this.cloud.pollPairingSession(secrets.sessionId);
      if (session.relationshipKeyCommitment !== secrets.relationshipKeyCommitment) {
        throw new Error('Pairing commitment changed during the handshake.');
      }

      if (!session.responderShare) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (session.handoff === null) {
        const handoff = await encryptRelationshipKey(
          current.relationshipKey,
          secrets.relationshipKeyCommitment,
          current.pendingPairing.confirmationCode,
          secrets,
          session.responderShare,
        );
        try {
          await this.cloud.publishPairingHandoff(secrets.sessionId, handoff);
        } catch (cause) {
          if (!(cause instanceof CloudClientError) || cause.code !== 'PAIRING_CONFLICT') throw cause;
        }
      }

      const afterHandoff = session.handoff
        ? session
        : await this.cloud.pollPairingSession(secrets.sessionId);

      if (!afterHandoff.confirmation) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      try {
        await this.verifyInitiatorConfirmation(
          current.pendingPairing.confirmationCode,
          secrets,
          afterHandoff.responderShare,
          afterHandoff.confirmation,
        );
      } catch (cause) {
        if (cause instanceof Error) throw cause;
        throw new Error('Pairing confirmation failed.');
      }

      if (!afterHandoff.completed) {
        try {
          await this.cloud.completePairingSession(secrets.sessionId);
        } catch (cause) {
          if (!(cause instanceof CloudClientError)) throw cause;
          const recovery = await this.cloud.pollPairingSession(secrets.sessionId);
          if (!recovery.completed) throw cause;
          afterHandoff.partnerDeviceId = recovery.partnerDeviceId;
        }
      }

      if (!afterHandoff.partnerDeviceId && afterHandoff.completed) {
        const recovery = await this.cloud.pollPairingSession(secrets.sessionId);
        if (!recovery.partnerDeviceId) throw new Error('Completed pairing did not return the partner device ID.');
        afterHandoff.partnerDeviceId = recovery.partnerDeviceId;
      }

      if (afterHandoff.completed || afterHandoff.partnerDeviceId) {
        const identity: CloudIdentity = {
          ...current,
          state: 'ACTIVE',
          pendingPairing: undefined,
        };
        await this.identityStore.save(identity);
        this.cloud.setCredential(identity.credential);
        return identity;
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new Error('Pairing session did not complete before it expired.');
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
    identity: CloudIdentity;
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

    return { response, relationshipKey, identity };
  }

  private async ensureInitiatorHandshake(identity: CloudIdentity): Promise<void> {
    const pending = identity.pendingPairing;
    if (!pending) throw new Error('Pending pairing invitation is missing.');

    if (!pending.handshake) {
      const sessionId = await generatePairingSessionId();
      const handshake = createPairingHandshake(
        sessionId,
        pending.confirmationCode,
        await this.keyCommitment(identity.relationshipKey),
      );
      const updated: CloudIdentity = {
        ...identity,
        pendingPairing: {
          ...pending,
          handshake: {
            sessionId,
            ephemeralSecret: handshake.ephemeralSecret,
            ownShare: handshake.share,
          },
        },
      };
      await this.identityStore.save(updated);
      identity = updated;
    }

    const current = await this.identityStore.load();
    if (!current?.pendingPairing?.handshake) throw new Error('Pending pairing handshake is unavailable.');

    const startResponse = await this.cloud.startPairingSession({
      sessionId: current.pendingPairing.handshake.sessionId,
      invitationId: current.pendingPairing.invitationId,
      share: current.pendingPairing.handshake.ownShare,
    });
    const expectedCommitment = await this.keyCommitment(current.relationshipKey);
    if (startResponse.relationshipKeyCommitment !== expectedCommitment) {
      throw new Error('Cloud returned a different pairing key commitment.');
    }
  }

  private async verifyInitiatorConfirmation(
    pairingCode: string,
    secrets: PairingHandshakeSecrets,
    responderShare: string | null,
    confirmation: string,
  ): Promise<void> {
    if (!responderShare) throw new Error('Pairing responder share is missing.');
    await (await import('./pairingHandshake.ts')).verifyPairingConfirmation(
      confirmation,
      pairingCode,
      secrets,
      responderShare,
    );
  }

  private async relationshipKeyFromSession(
    pairingCode: string,
    secrets: PairingHandshakeSecrets,
    responderShare: string,
    handoff: string | null,
    commitment: string,
  ): Promise<string> {
    if (!handoff) throw new Error('Pairing completed without a relationship-key handoff.');
    const key = await decryptRelationshipKey(
      handoff,
      commitment,
      pairingCode,
      secrets,
      secrets.role === 'RESPONDER' ? secrets.ownShare : responderShare,
    );
    const actualCommitment = await this.keyCommitment(key);
    if (actualCommitment !== commitment) throw new Error('Paired relationship key commitment does not match.');
    return key;
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
