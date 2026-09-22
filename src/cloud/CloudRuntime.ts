import { initializeDatabase } from '../data/database.ts';
import { SQLiteSyncStateStore } from '../data/SQLiteSyncStateStore.ts';
import type { SQLiteRucolaRepository } from '../data/SQLiteRucolaRepository.ts';
import { AesGcmSyncCodec } from '../crypto/messageCodec.ts';
import { expoAesGcmProvider } from '../crypto/expoAesGcm.ts';
import { SyncEngine, type SyncRunResult } from '../sync/SyncEngine.ts';
import { CloudClient } from './CloudClient.ts';
import { CloudIdentityStore, type CloudIdentity } from './CloudIdentityStore.ts';
import {
  PairingManager,
  type PairingInput,
  type PairingInvitationView,
  type PendingPairingView,
} from './PairingManager.ts';
import { getCloudBaseUrl } from './config.ts';
import { expoSecureValueStore } from './expoSecureStore.ts';

export class CloudRuntime {
  readonly cloud: CloudClient;
  readonly identityStore: CloudIdentityStore;
  readonly pairing: PairingManager;

  private syncEngine: SyncEngine | null = null;
  private syncEngineIdentityKey: string | null = null;
  private syncSetupPromise: Promise<SyncEngine | null> | null = null;

  constructor() {
    this.cloud = new CloudClient({ baseUrl: getCloudBaseUrl() });
    this.identityStore = new CloudIdentityStore(expoSecureValueStore);
    this.pairing = new PairingManager({
      cloud: this.cloud,
      identityStore: this.identityStore,
    });
  }

  loadIdentity(): Promise<CloudIdentity | null> {
    return this.identityStore.load();
  }

  startPairing(expiresInSeconds?: number): Promise<PendingPairingView> {
    return this.pairing.startPairing(expiresInSeconds);
  }

  startPairingInvitation(expiresInSeconds?: number): Promise<PairingInvitationView> {
    return this.pairing.startPairingInvitation(expiresInSeconds);
  }

  resumePendingPairing(): Promise<PendingPairingView | null> {
    return this.pairing.resumePendingPairing();
  }

  resumePendingPairingInvitation(): Promise<PairingInvitationView | null> {
    return this.pairing.resumePendingPairingInvitation();
  }

  acceptPairingInput(input: PairingInput): Promise<CloudIdentity> {
    return this.pairing.acceptPairingInput(input);
  }

  completePendingPairing(): Promise<CloudIdentity | null> {
    return this.pairing.completePendingPairing();
  }

  resumePendingPartnerPairing(): Promise<CloudIdentity | null> {
    return this.pairing.resumePendingPartnerPairing();
  }

  normalizePairingInput(input: PairingInput) {
    return this.pairing.normalizePairingInput(input);
  }

  acceptPairingPackage(encodedPackage: string, confirmationCode: string) {
    return this.pairing.acceptPairingPackage(encodedPackage, confirmationCode);
  }

  cancelPendingPairing(): Promise<void> {
    return this.pairing.cancelPendingPairing();
  }

  async refreshRelationshipState(): Promise<CloudIdentity | null> {
    const identity = await this.pairing.refreshRelationshipState();
    if (!identity || identity.state !== 'ACTIVE') {
      this.invalidateSyncEngine();
    }
    return identity;
  }

  async sync(repository: SQLiteRucolaRepository): Promise<SyncRunResult | null> {
    const engine = await this.getSyncEngine(repository);
    if (!engine) return null;
    return engine.run();
  }

  async refreshAndSync(repository: SQLiteRucolaRepository): Promise<SyncRunResult | null> {
    const identity = await this.refreshRelationshipState();
    if (!identity || identity.state !== 'ACTIVE') return null;
    return this.sync(repository);
  }

  clear(): Promise<void> {
    this.invalidateSyncEngine();
    this.cloud.clearCredential();
    return this.identityStore.clear();
  }

  private async getSyncEngine(repository: SQLiteRucolaRepository): Promise<SyncEngine | null> {
    const identity = await this.identityStore.load();
    if (!identity || identity.state !== 'ACTIVE') {
      this.invalidateSyncEngine();
      return null;
    }

    const identityKey = [
      identity.relationshipId,
      identity.deviceId,
      identity.participant,
    ].join(':');

    if (this.syncEngine && this.syncEngineIdentityKey === identityKey) return this.syncEngine;
    if (!this.syncSetupPromise) {
      this.syncSetupPromise = this.createSyncEngine(repository, identity, identityKey).finally(() => {
        this.syncSetupPromise = null;
      });
    }
    return this.syncSetupPromise;
  }

  private async createSyncEngine(repository: SQLiteRucolaRepository, identity: CloudIdentity, identityKey: string): Promise<SyncEngine> {
    const database = await initializeDatabase();
    const state = new SQLiteSyncStateStore({ database });
    await state.setDevice(identity.deviceId, identity.participant);
    const codec = new AesGcmSyncCodec({
      relationshipId: identity.relationshipId,
      relationshipKey: identity.relationshipKey,
      provider: expoAesGcmProvider,
    });

    this.cloud.setCredential(identity.credential);
    const engine = new SyncEngine({
      cloud: this.cloud,
      state,
      repository,
      codec,
    });
    this.syncEngine = engine;
    this.syncEngineIdentityKey = identityKey;
    return engine;
  }

  private invalidateSyncEngine(): void {
    this.syncEngine = null;
    this.syncEngineIdentityKey = null;
  }
}

export const cloudRuntime = new CloudRuntime();
