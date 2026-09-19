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
    credential: 'credential_abc123',
    relationshipKey: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}

test('persists and loads a cloud identity', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.save(identity());
  assert.deepEqual(await store.load(), identity());
});

test('overwrites the previous identity', async () => {
  const backend = createStore();
  const store = new CloudIdentityStore(backend);
  await store.save(identity());
  await store.save(identity({ deviceId: 'device-2', participant: 'PARTNER' }));
  assert.deepEqual(await store.load(), identity({ deviceId: 'device-2', participant: 'PARTNER' }));
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
  const secret = 'credential_super_secret';
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
