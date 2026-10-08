import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingManager } from '../PairingManager.ts';

const CODE = '😀😃😄😁😆';

function identityStore(identity = null) {
  return {
    async load() {
      return identity;
    },
  };
}

test('rejects pairing input when this device already has a cloud identity', async () => {
  let joined = false;
  const manager = new PairingManager({
    cloud: {
      async joinPairingSession() {
        joined = true;
        throw new Error('should not be called');
      },
    },
    identityStore: identityStore({
      relationshipId: 'relationship',
      deviceId: 'device',
      participant: 'ME',
      state: 'ACTIVE',
      credential: 'credential',
      relationshipKey: Buffer.alloc(32, 7).toString('base64'),
    }),
  });

  await assert.rejects(
    () => manager.acceptPairingInput({ transport: 'EMOJI', value: CODE }),
    /A cloud identity already exists on this device/,
  );
  assert.equal(joined, false);
});

test('normalizes both pairing transports to the same emoji code', () => {
  const manager = new PairingManager({
    cloud: {},
    identityStore: identityStore(),
  });

  assert.deepEqual(
    manager.normalizePairingInput({ transport: 'EMOJI', value: CODE }),
    { transport: 'EMOJI', pairingCode: CODE },
  );
});
