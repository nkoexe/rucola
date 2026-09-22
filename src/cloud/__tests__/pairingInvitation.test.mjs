import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingManager } from '../PairingManager.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CODE = '😀😃😄😁😆';
const COMMITMENT = 'a'.repeat(64);

function identityStore(initial = null) {
  let identity = initial;
  return {
    async load() { return identity; },
    async save(next) { identity = next; },
    async clear() { identity = null; },
  };
}

function cloudStub() {
  return {
    setCredential() {},
    async bootstrapPairing() {
      return {
        relationshipId: 'relationship-1',
        invitationId: 'invitation-1',
        deviceId: 'device-1',
        participant: 'ME',
        credential: 'credential-1',
        token: 'a'.repeat(43),
        confirmationCode: CODE,
        relationshipKeyCommitment: COMMITMENT,
        expiresAt: 10_000,
      };
    },
    async startPairingSession() {
      return {
        sessionId: 'BwcHBwcHBwcHBwcHBwcHBQ==',
        expiresAt: 10_000,
        relationshipKeyCommitment: COMMITMENT,
      };
    },
  };
}

test('startPairingInvitation exposes only human pairing data', async () => {
  const manager = new PairingManager({
    cloud: cloudStub(),
    identityStore: identityStore(),
    keyGenerator: async () => KEY,
    keyCommitment: async () => COMMITMENT,
    now: () => 1_000,
  });

  const invitation = await manager.startPairingInvitation(600);
  assert.deepEqual(invitation, {
    pairingCode: CODE,
    shareUrl: 'https://rucola.njco.dev/%F0%9F%98%80%F0%9F%98%83%F0%9F%98%84%F0%9F%98%81%F0%9F%98%86',
    expiresAt: 10_000,
  });
  assert.equal('token' in invitation, false);
  assert.equal('relationshipId' in invitation, false);
  assert.equal('deviceId' in invitation, false);
  assert.equal('relationshipKey' in invitation, false);
});

test('resumePendingPairingInvitation reconstructs the same human-facing view', async () => {
  const store = identityStore({
    relationshipId: 'relationship-1',
    deviceId: 'device-1',
    participant: 'ME',
    state: 'PAIRING',
    credential: 'credential-1',
    relationshipKey: KEY,
    pendingPairing: {
      invitationId: 'invitation-1',
      token: 'a'.repeat(43),
      confirmationCode: CODE,
      expiresAt: 10_000,
    },
  });
  const manager = new PairingManager({
    cloud: cloudStub(),
    identityStore: store,
    keyCommitment: async () => COMMITMENT,
    now: () => 1_000,
  });

  const invitation = await manager.resumePendingPairingInvitation();
  assert.deepEqual(invitation, {
    pairingCode: CODE,
    shareUrl: 'https://rucola.njco.dev/%F0%9F%98%80%F0%9F%98%83%F0%9F%98%84%F0%9F%98%81%F0%9F%98%86',
    expiresAt: 10_000,
  });
});
