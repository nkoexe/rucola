import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudIdentityStore } from '../CloudIdentityStore.ts';

function createStore() {
  const values = new Map();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    deleteItem: async (key) => { values.delete(key); },
  };
}

function identity(overrides = {}) {
  return {
    relationshipId: 'relationship-1',
    deviceId: 'device-1',
    participant: 'ME',
    state: 'ACTIVE',
    credential: 'credential_abc123',
    relationshipKey: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}


function pendingPairingSession(overrides = {}) {
  return {
    invitationId: 'invitation-1',
    relationshipId: 'relationship-1',
    relationshipKeyCommitment: 'a'.repeat(64),
    sessionId: Buffer.alloc(16, 7).toString('base64'),
    confirmationCode: '😀😃😄😁😆',
    expiresAt: Date.now() + 60_000,
    ephemeralSecret: Buffer.alloc(32, 8).toString('base64'),
    ownShare: Buffer.alloc(32, 9).toString('base64'),
    partnerDeviceId: 'partner_device_1',
    credential: 'a'.repeat(43),
    relationshipKey: null,
    ...overrides,
  };
}

function pairing() {
  return {
    invitationId: 'invitation-1',
    token: 'a'.repeat(43),
    confirmationCode: '😀😃😄😁😆',
    expiresAt: Date.now() + 60_000,
  };
}


test('persists and loads a pending responder pairing session', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  const pending = pendingPairingSession();
  await store.savePendingPairingSession(pending);
  assert.deepEqual(await store.loadPendingPairingSession(), pending);
});

test('pending responder pairing session may gain its relationship key', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  const pending = pendingPairingSession({ relationshipKey: Buffer.alloc(32, 7).toString('base64') });
  await store.savePendingPairingSession(pending);
  assert.equal((await store.loadPendingPairingSession()).relationshipKey, pending.relationshipKey);
});

test('clear removes pending responder pairing session independently', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.savePendingPairingSession(pendingPairingSession());
  await store.clearPendingPairingSession();
  assert.equal(await store.loadPendingPairingSession(), null);
  assert.equal(backend.values.has('rucola.cloud.pending-pairing-session.v1'), false);
});

test('persists and loads a cloud identity', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.save(identity());
  assert.deepEqual(await store.load(), identity());
});

test('persists a recoverable pending pairing state', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  const pending = { ...identity(), state: 'PAIRING', pendingPairing: pairing() };
  await store.save(pending);
  assert.deepEqual(await store.load(), pending);
});

test('rejects an active identity with pending pairing state', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await assert.rejects(
    () => store.save({ ...identity(), state: 'ACTIVE', pendingPairing: pairing() }),
    /cannot have pending pairing/,
  );
});

test('rejects pairing state without pending invitation', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await assert.rejects(
    () => store.save({ ...identity(), state: 'PAIRING' }),
    /Stored pairing state is missing/,
  );
});

test('overwrites the previous identity', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.save(identity());
  await store.save(identity({ deviceId: 'device-2', participant: 'PARTNER' }));
  assert.deepEqual(await store.load(), identity({ deviceId: 'device-2', participant: 'PARTNER' }));
});

test('clear removes both identity and pending responder pairing state', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.save(identity());
  await store.savePendingPairingSession(pendingPairingSession());
  await store.clear();
  assert.equal(await store.load(), null);
  assert.equal(await store.loadPendingPairingSession(), null);
  assert.equal(backend.values.size, 0);
});

test('clear removes all identity material', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.save(identity());
  await store.clear();
  assert.equal(await store.load(), null);
  assert.equal(backend.values.size, 0);
});

test('malformed persisted data is rejected without exposing secrets', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  const secret = 'credential secret';
  backend.values.set('rucola.cloud.identity.v1', JSON.stringify({ ...identity(), credential: secret }));
  await assert.rejects(() => store.load(), /Cloud credential is invalid/);
  backend.values.set('rucola.cloud.identity.v1', '{not-json');
  await assert.rejects(() => store.load(), (error) => !String(error.message).includes(secret));
});

test('invalid stored keys and roles are rejected', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await assert.rejects(() => store.save(identity({ relationshipKey: 'not-a-key' })), /Relationship encryption key is invalid/);
  await assert.rejects(() => store.save(identity({ participant: 'UNKNOWN' })), /Stored cloud participant is invalid/);
  await assert.rejects(() => store.save(identity({ deviceId: 'bad id' })), /Device ID is invalid/);
});
