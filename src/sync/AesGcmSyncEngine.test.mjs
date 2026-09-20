import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { AesGcmSyncCodec } from '../crypto/messageCodec.ts';
import { SyncEngine } from './SyncEngine.ts';

const provider = {
  async encrypt(plaintext, keyBase64, additionalData) {
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(keyBase64, 'base64'), { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, plaintext));
    return { iv, ciphertext: sealed.slice(0, -16), tag: sealed.slice(-16) };
  },
  async decrypt(parts, keyBase64, additionalData) {
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(keyBase64, 'base64'), { name: 'AES-GCM' }, false, ['decrypt']);
    const sealed = new Uint8Array(parts.ciphertext.length + parts.tag.length);
    sealed.set(parts.ciphertext);
    sealed.set(parts.tag, parts.ciphertext.length);
    return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: parts.iv, additionalData, tagLength: 128 }, key, sealed));
  },
};

function key() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

test('SyncEngine pushes ciphertext that decrypts with the durable sender sequence', async () => {
  const relationshipKey = key();
  const senderCodec = new AesGcmSyncCodec({ relationshipId: 'cloud-relationship', relationshipKey, provider });
  const recipientCodec = new AesGcmSyncCodec({ relationshipId: 'cloud-relationship', relationshipKey, provider });
  const message = {
    id: 'message-1',
    relationshipId: 'the-one',
    participant: 'ME',
    type: 'TEXT',
    body: 'hello 🌶️',
    createdAt: 1_700_000_000_000,
    isActive: true,
    syncState: 'PENDING',
    orderIndex: 1,
    mediaReference: null,
  };
  const calls = [];
  const state = {
    reconcileOutbox: async () => {},
    getPendingOutbox: async () => [{ messageId: 'message-1', senderSeq: 7, nextAttemptAt: 0, ciphertext: null, encryptionVersion: null }],
    storeOutboundCiphertext: async (id, ciphertext, encryptionVersion) => calls.push(['storeOutboundCiphertext', id, ciphertext, encryptionVersion]),
    markSynced: async (id) => calls.push(['markSynced', id]),
    markAttemptFailed: async () => {},
    markBlocked: async () => {},
    getPullCursor: async () => 0,
    commitInbound: async () => {},
  };
  const repository = { getMessages: async () => [message] };
  const cloud = {
    pushMessage: async (payload) => calls.push(['push', payload]),
    pullMessages: async () => ({ messages: [], nextCursor: 0, hasMore: false }),
    acknowledgeMessages: async (through) => ({ acknowledgedThrough: through, deleted: 0, acknowledgedAt: 1 }),
  };

  const engine = new SyncEngine({
    cloud,
    state,
    repository,
    codec: senderCodec,
  });

  const result = await engine.run();
  assert.equal(result.pushed, 1);
  assert.equal(calls[1][0], 'push');
  const pushed = calls[1][1];
  const decoded = await recipientCodec.decrypt({
    messageId: pushed.messageId,
    senderSeq: pushed.senderSeq,
    type: pushed.type,
    encryptionVersion: pushed.encryptionVersion,
    ciphertext: pushed.ciphertext,
  });
  assert.deepEqual(decoded, { type: 'TEXT', body: 'hello 🌶️', mediaReference: null });
  assert.deepEqual(calls[2], ['markSynced', 'message-1']);
  await assert.rejects(
    () => recipientCodec.decrypt({ ...pushed, senderSeq: 8 }),
  );
});
