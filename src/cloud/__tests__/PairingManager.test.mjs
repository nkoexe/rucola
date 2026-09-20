import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingManager } from '../PairingManager.ts';
import { createPairingPackage } from '../pairingPackage.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const COMMITMENT = 'a'.repeat(64);
const CODE = '😀😃😄😁😆';

function identityStore() {
  let identity = null;
  return {
    async load() { return identity; },
    async save(next) { identity = next; },
    async clear() { identity = null; },
    getIdentity() { return identity; },
  };
}

test('pairing acceptance uses the server relationship binding, not advisory package IDs', async () => {
  const store = identityStore();
  const calls = [];
  const cloud = {
    setCredential() {},
    async acceptInvitation(token, confirmationCode, relationshipKeyCommitment) {
      calls.push({ token, confirmationCode, relationshipKeyCommitment });
      return {
        relationshipId: 'server-relationship',
        deviceId: 'partner-device',
        participant: 'PARTNER',
        credential: 'partner-credential',
        relationshipKeyCommitment: COMMITMENT,
      };
    },
  };

  const manager = new PairingManager({
    cloud,
    identityStore: store,
    keyCommitment: async () => COMMITMENT,
    now: () => 1_000,
  });

  const encoded = await createPairingPackage({
    relationshipId: 'original-relationship',
    invitationId: 'original-invitation',
    deviceId: 'me-device',
    participant: 'ME',
    credential: 'me-credential',
    token: 'a'.repeat(43),
    confirmationCode: CODE,
    relationshipKeyCommitment: COMMITMENT,
    expiresAt: 4_000_000_000_000,
  }, KEY);

  const payload = JSON.parse(Buffer.from(
    encoded.slice('rucola-pairing:v1.'.length).replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8'));
  payload.relationshipId = 'modified-relationship';
  const tamperedMetadata = 'rucola-pairing:v1.' + Buffer.from(JSON.stringify(payload)).toString('base64url');

  const result = await manager.acceptPairingPackage(tamperedMetadata, CODE);

  assert.equal(result.identity.relationshipId, 'server-relationship');
  assert.equal(result.identity.deviceId, 'partner-device');
  assert.equal(result.identity.relationshipKey, KEY);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    token: 'a'.repeat(43),
    confirmationCode: CODE,
    relationshipKeyCommitment: COMMITMENT,
  });
  assert.equal(store.getIdentity()?.relationshipId, 'server-relationship');
});