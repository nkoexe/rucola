import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncEngine } from './SyncEngine.ts';
import { CloudClientError } from '../cloud/CloudClient.ts';

function message(overrides = {}) {
  return {
    id: 'local-1', relationshipId: 'the-one', participant: 'ME', type: 'TEXT', body: 'hello',
    createdAt: 1_700_000_000_000, isActive: true, syncState: 'PENDING', orderIndex: 1, mediaReference: null, ...overrides,
  };
}

function createHarness({ pullResponse, inboundCommitError } = {}) {
  const calls = [];
  const messages = [message()];
  let cursor = 0;
  const outbox = [{ messageId: 'local-1', senderSeq: 1, attempts: 0, lastError: null, nextAttemptAt: 0, createdAt: 1 }];
  const state = {
    reconcileOutbox: async () => calls.push(['reconcileOutbox']),
    getDueOutbox: async () => outbox,
    markSynced: async (id) => calls.push(['markSynced', id]),
    markAttemptFailed: async (id, error) => calls.push(['markAttemptFailed', id, error.message]),
    markBlocked: async (id, error) => calls.push(['markBlocked', id, error.message]),
    getPullCursor: async () => cursor,
    commitInbound: async (batch, nextCursor) => {
      calls.push(['commitInbound', batch, nextCursor]);
      if (inboundCommitError) throw inboundCommitError;
      cursor = nextCursor;
    },
  };
  const repository = { getMessages: async () => messages };
  const cloud = {
    pushMessage: async (payload) => calls.push(['push', payload]),
    pullMessages: async () => pullResponse ?? { messages: [], nextCursor: cursor, hasMore: false },
    acknowledgeMessages: async (through) => { calls.push(['ack', through]); return { acknowledgedThrough: through, deleted: 1, acknowledgedAt: 2 }; },
  };
  const codec = {
    encryptionVersion: 1,
    encrypt: async (local) => `cipher:${local.body}`,
    decrypt: async (remote) => ({ type: remote.type, body: `decoded:${remote.ciphertext}` }),
  };
  return { calls, state, repository, cloud, codec };
}

function inbound(overrides = {}) {
  return {
    messageId: 'remote-1', senderDeviceId: 'device-b', senderParticipant: 'PARTNER', senderSeq: 1,
    createdAt: 1_700_000_000_100, serverSeq: 7, receivedAt: 1_700_000_000_200,
    type: 'TEXT', ciphertext: 'hello', encryptionVersion: 1, mediaUploadId: null, ...overrides,
  };
}

test('pushes due local messages with durable sender sequence', async () => {
  const harness = createHarness();
  const engine = new SyncEngine({ ...harness });
  const result = await engine.run();
  assert.equal(result.pushed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(harness.calls[1], ['push', { messageId: 'local-1', senderSeq: 1, type: 'TEXT', ciphertext: 'cipher:hello', encryptionVersion: 1, createdAt: 1_700_000_000_000 }]);
  assert.deepEqual(harness.calls[2], ['markSynced', 'local-1']);
});

test('does not ACK inbound data before local commit succeeds', async () => {
  const harness = createHarness({ pullResponse: { messages: [inbound()], nextCursor: 7, hasMore: false }, inboundCommitError: new Error('sqlite failed') });
  const engine = new SyncEngine({ ...harness });
  await assert.rejects(() => engine.run(), /sqlite failed/);
  assert.equal(harness.calls.some(([name]) => name === 'ack'), false);
});

test('ACK happens only after the inbound transaction resolves', async () => {
  const harness = createHarness({ pullResponse: { messages: [inbound()], nextCursor: 7, hasMore: false } });
  const engine = new SyncEngine({ ...harness });
  const result = await engine.run();
  assert.equal(result.pulled, 1);
  assert.equal(result.acknowledged, 1);
  assert.deepEqual(harness.calls.map(([name]) => name), ['reconcileOutbox', 'push', 'markSynced', 'commitInbound', 'ack']);
});

test('concurrent sync triggers coalesce into one pass', async () => {
  const harness = createHarness();
  let pulls = 0;
  const originalPull = harness.cloud.pullMessages;
  harness.cloud.pullMessages = async (...args) => { pulls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return originalPull(...args); };
  const engine = new SyncEngine({ ...harness });
  const [first, second] = await Promise.all([engine.run(), engine.run()]);
  assert.strictEqual(first, second);
  assert.equal(pulls, 1);
});

test('media messages remain durably blocked without blocking later text', async () => {
  const harness = createHarness();
  harness.repository.getMessages = async () => [
    message({ id: 'media-1', type: 'PHOTO_VIDEO', mediaReference: 'rucola-media://photo', orderIndex: 1 }),
    message({ id: 'text-2', body: 'later', orderIndex: 2 }),
  ];
  harness.state.getDueOutbox = async () => [
    { messageId: 'media-1', senderSeq: 1, attempts: 0, lastError: null, nextAttemptAt: 0, createdAt: 1 },
    { messageId: 'text-2', senderSeq: 2, attempts: 0, lastError: null, nextAttemptAt: 0, createdAt: 2 },
  ];
  const engine = new SyncEngine({ ...harness });
  const result = await engine.run();
  assert.equal(result.pushed, 1);
  assert.equal(result.failed, 1);
  assert.equal(harness.calls.some(([name, id]) => name === 'markBlocked' && id === 'media-1'), true);
  assert.equal(harness.calls.some(([name]) => name === 'push'), true);
  assert.deepEqual(harness.calls.find(([name, payload]) => name === 'push' && payload?.messageId === 'text-2')?.[1]?.senderSeq, 2);
});

test('transient cloud failures remain retryable and preserve sender ordering', async () => {
  const harness = createHarness();
  harness.repository.getMessages = async () => [message({ id: 'local-1' }), message({ id: 'local-2', body: 'second', orderIndex: 2 })];
  harness.state.getDueOutbox = async () => [
    { messageId: 'local-1', senderSeq: 1, attempts: 0, lastError: null, nextAttemptAt: 0, createdAt: 1 },
    { messageId: 'local-2', senderSeq: 2, attempts: 0, lastError: null, nextAttemptAt: 0, createdAt: 2 },
  ];
  harness.cloud.pushMessage = async () => { throw new CloudClientError({ code: 'CLIENT_TIMEOUT', message: 'timeout', status: 0 }); };
  const engine = new SyncEngine({ ...harness });
  const result = await engine.run();
  assert.equal(result.failed, 1);
  assert.equal(harness.calls.filter(([name]) => name === 'push').length, 1);
  assert.equal(harness.calls.some(([name, id]) => name === 'markAttemptFailed' && id === 'local-2'), false);
});

test('permanent cloud failures are blocked instead of retried forever', async () => {
  const harness = createHarness();
  harness.cloud.pushMessage = async () => { throw new CloudClientError({ code: 'MESSAGE_ID_CONFLICT', message: 'conflict', status: 409 }); };
  const engine = new SyncEngine({ ...harness });
  const result = await engine.run();
  assert.equal(result.failed, 1);
  assert.equal(harness.calls.some(([name]) => name === 'markBlocked'), true);
  assert.equal(harness.calls.some(([name]) => name === 'markAttemptFailed'), false);
});

test('rejects inbound data from the wrong participant before local commit', async () => {
  const harness = createHarness({ pullResponse: { messages: [inbound({ senderParticipant: 'ME' })], nextCursor: 7, hasMore: false } });
  const engine = new SyncEngine({ ...harness });
  await assert.rejects(() => engine.run(), /invalid sender/);
  assert.equal(harness.calls.some(([name]) => name === 'commitInbound'), false);
  assert.equal(harness.calls.some(([name]) => name === 'ack'), false);
});

test('rejects hasMore=true with an empty batch', async () => {
  const harness = createHarness({ pullResponse: { messages: [], nextCursor: 0, hasMore: true } });
  const engine = new SyncEngine({ ...harness });
  await assert.rejects(() => engine.run(), /more inbound messages/);
});
