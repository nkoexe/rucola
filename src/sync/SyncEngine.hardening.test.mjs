import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncDecryptionError, SyncEngine } from './SyncEngine.ts';

function localMessage(id = 'local-1', overrides = {}) {
  return { id, relationshipId: 'the-one', participant: 'ME', type: 'TEXT', body: id, createdAt: 1_700_000_000_000, isActive: true, syncState: 'PENDING', orderIndex: 1, mediaReference: null, ...overrides };
}

function inbound(id, serverSeq, overrides = {}) {
  return { messageId: id, senderDeviceId: 'device-b', senderParticipant: 'PARTNER', senderSeq: serverSeq, createdAt: 1_700_000_000_100 + serverSeq, serverSeq, receivedAt: 1_700_000_000_200 + serverSeq, type: 'TEXT', ciphertext: `cipher-${serverSeq}`, encryptionVersion: 1, mediaUploadId: null, ...overrides };
}

function harness({ pullResponse, decrypt, now = 1_700_000_100_000, reconcileOutbox } = {}) {
  const calls = [];
  const cursorState = { value: 0 };
  const messages = [localMessage()];
  const state = {
    reconcileOutbox: async () => { calls.push(['reconcileOutbox']); return reconcileOutbox?.() ?? 0; },
    getPendingOutbox: async () => [{ messageId: 'local-1', senderSeq: 1, attempts: 0, lastError: null, nextAttemptAt: 0, blocked: 0, createdAt: messages[0].createdAt }],
    markSynced: async (id) => calls.push(['markSynced', id]),
    markAttemptFailed: async (id, error) => calls.push(['markAttemptFailed', id, error.message]),
    markBlocked: async (id, error) => calls.push(['markBlocked', id, error.message]),
    getPullCursor: async () => cursorState.value,
    commitInbound: async (accepted, nextCursor, commitNow, dropped) => { calls.push(['commitInbound', accepted, nextCursor, commitNow, dropped]); cursorState.value = nextCursor; },
  };
  const repository = { getMessages: async () => messages };
  const cloud = {
    pushMessage: async (payload) => calls.push(['push', payload]),
    pullMessages: async () => pullResponse ?? { messages: [], nextCursor: cursorState.value, hasMore: false },
    acknowledgeMessages: async (through) => { calls.push(['ack', through]); return { acknowledgedThrough: through, deleted: 1, acknowledgedAt: now }; },
  };
  const codec = {
    encryptionVersion: 1,
    encrypt: async (message, senderSeq) => `cipher:${senderSeq}:${message.body}`,
    decrypt: decrypt ?? (async (remote) => ({ type: remote.type, body: `decoded:${remote.ciphertext}` })),
  };
  return { calls, state, repository, cloud, codec, now: () => now };
}

test('drops one undecryptable inbound message and still commits later messages', async () => {
  const response = { messages: [inbound('bad-1', 7), inbound('good-2', 8)], nextCursor: 8, hasMore: false };
  const testHarness = harnessForDecryptFailure(response);
  const engine = new SyncEngine({ ...testHarness });
  const result = await engine.run();

  assert.equal(result.pulled, 1);
  assert.equal(result.failed, 0);
  const commit = testHarness.calls.find(([name]) => name === 'commitInbound');
  assert.ok(commit);
  assert.deepEqual(commit[1].map((message) => message.id), ['good-2']);
  assert.deepEqual(commit[4], [{ messageId: 'bad-1', serverSeq: 7, reason: 'DECRYPTION_FAILED' }]);
  assert.equal(commit[2], 8);
  assert.deepEqual(testHarness.calls.at(-1), ['ack', 8]);
});

test('drops a whole undecryptable batch without poisoning the cursor', async () => {
  const response = { messages: [inbound('bad-1', 5), inbound('bad-2', 6)], nextCursor: 6, hasMore: false };
  const testHarness = harnessForDecryptFailure(response);
  const engine = new SyncEngine({ ...testHarness });
  const result = await engine.run();

  assert.equal(result.pulled, 0);
  assert.equal(result.failed, 0);
  const commit = testHarness.calls.find(([name]) => name === 'commitInbound');
  assert.ok(commit);
  assert.deepEqual(commit[1], []);
  assert.deepEqual(commit[4], [
    { messageId: 'bad-1', serverSeq: 5, reason: 'DECRYPTION_FAILED' },
    { messageId: 'bad-2', serverSeq: 6, reason: 'DECRYPTION_FAILED' },
  ]);
  assert.deepEqual(testHarness.calls.at(-1), ['ack', 6]);
});

test('treats a codec type mismatch as a dropped inbound message', async () => {
  const response = { messages: [inbound('bad-type', 3)], nextCursor: 3, hasMore: false };
  const testHarness = harnessForDecryptFailure(response, async () => ({ type: 'EMOJI', body: 'wrong' }));
  const engine = new SyncEngine({ ...testHarness });
  await engine.run();

  const commit = testHarness.calls.find(([name]) => name === 'commitInbound');
  assert.ok(commit);
  assert.deepEqual(commit[4], [{ messageId: 'bad-type', serverSeq: 3, reason: 'DECRYPTION_FAILED' }]);
});

test('propagates unexpected codec errors instead of dropping the message', async () => {
  const response = { messages: [inbound('runtime-failure', 4)], nextCursor: 4, hasMore: false };
  const testHarness = harness({ pullResponse: response, decrypt: async () => { throw new Error('codec runtime failure'); } });
  const engine = new SyncEngine({ ...testHarness });
  await assert.rejects(() => engine.run(), /codec runtime failure/);
  assert.equal(testHarness.calls.some(([name]) => name === 'commitInbound'), false);
  assert.equal(testHarness.calls.some(([name]) => name === 'ack'), false);
});

test('does not ACK when local commit of accepted and dropped messages fails', async () => {
  const response = { messages: [inbound('bad-1', 2)], nextCursor: 2, hasMore: false };
  const testHarness = harnessForDecryptFailure(response);
  testHarness.state.commitInbound = async (...args) => { testHarness.calls.push(['commitInbound', ...args]); throw new Error('sqlite failed'); };
  const engine = new SyncEngine({ ...testHarness });
  await assert.rejects(() => engine.run(), /sqlite failed/);
  assert.equal(testHarness.calls.some(([name]) => name === 'ack'), false);
});

function harnessForDecryptFailure(pullResponse, decryptOverride) {
  return harness({
    pullResponse,
    decrypt: decryptOverride ?? (async (remote) => {
      if (remote.messageId.startsWith('bad-')) throw new SyncDecryptionError('unable to decrypt');
      return { type: remote.type, body: `decoded:${remote.ciphertext}` };
    }),
  });
}
