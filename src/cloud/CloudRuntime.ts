import { CloudClient } from './CloudClient.ts';
import { CloudIdentityStore, type CloudIdentity } from './CloudIdentityStore.ts';
import { PairingManager, type PendingPairingView } from './PairingManager.ts';
import { getCloudBaseUrl } from './config.ts';
import { expoSecureValueStore } from './expoSecureStore.ts';

export class CloudRuntime {
  readonly cloud: CloudClient;
  readonly identityStore: CloudIdentityStore;
  readonly pairing: PairingManager;

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

  resumePendingPairing(): Promise<PendingPairingView | null> {
    return this.pairing.resumePendingPairing();
  }

  acceptPairingPackage(encodedPackage: string, confirmationCode: string) {
    return this.pairing.acceptPairingPackage(encodedPackage, confirmationCode);
  }

  cancelPendingPairing(): Promise<void> {
    return this.pairing.cancelPendingPairing();
  }

  refreshRelationshipState(): Promise<CloudIdentity | null> {
    return this.pairing.refreshRelationshipState();
  }

  clear(): Promise<void> {
    this.cloud.clearCredential();
    return this.identityStore.clear();
  }
}

export const cloudRuntime = new CloudRuntime();
