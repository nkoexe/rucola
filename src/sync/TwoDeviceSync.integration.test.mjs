import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { CloudClientError } from '../cloud/CloudClient.ts';
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

function message(id, participant, body, orderIndex) {
  return {
    id,
    relationshipId: 'the-one',
    participant,
    type: 'TEXT',
    body,
    createdAt: 1_700_000_000_000 + orderIndex,
    isActive: true,
    syncState: 'PENDING',
    orderIndex,
    mediaReference: null,
  };
}

class MemoryServer {
  constructor() {
    this.serverSeq = 0;
    this.messages = [];
    this.dropNextPushResponse = new Set();
  }

  createClient(deviceId, participant) {
    return {
      pushMessage: async (payload) => {
        let existing = this.messages.find((item) => item.senderDeviceId === deviceId && item.messageId === payload.messageId);
        if (!existing) {
          existing = {
            ...payload,
            senderDeviceId: deviceId,
            senderParticipant: participant,
            serverSeq: ++this.serverSeq,
            receivedAt: payload.createdAt + 1,
            targetDeviceId: participant === 'ME' ? 'device-b' : 'device-a',
          };
          this.messages.push(existing);
        } else if (
          existing.senderSeq !== payload.senderSeq ||
          existing.type !== payload.type ||
          existing.ciphertext !== payload.ciphertext ||
          existing.encryptionVersion !== payload.encryptionVersion ||
          existing.createdAt !== payload.createdAt
        ) {
          throw new CloudClientError({ code: 'MESSAGE_ID_CONFLICT', message: 'message identity conflict', status: 409 });
        }

        if (this.dropNextPushResponse.delete(deviceId)) {
          throw new CloudClientError({ code: 'CLIENT_TIMEOUT', message: 'response lost after acceptance', status: 0 });
        }

        return {
          messageId: existing.messageId,
          serverSeq: existing.serverSeq,
          acceptedAt: existing.receivedAt,
        };
      },
      pullMessages: async (after, limit) => {
        const messages = this.messages
          .filter((item) => item.targetDeviceId === deviceId && item.serverSeq > after)
          .sort((a, b) => a.serverSeq - b.serverSeq)
          .slice(0, limit);
        return {
          messages,
          nextCursor: messages.at(-1)?.serverSeq ?? after,
          hasMore: this.messages.some((item) => item.targetDeviceId === deviceId && item.serverSeq > (messages.at(-1)?.serverSeq ?? after)),
        };
      },
      acknowledgeMessages: async (through) => {
        const before = this.messages.length;
        this.messages = this.messages.filter((item) => !(item.targetDeviceId === deviceId && item.serverSeq <= through));
        return { acknowledgedThrough: through, deleted: before - this.messages.length, acknowledgedAt: Date.now() };
      },
    };
  }
}

class MemoryState {
  constructor(deviceId, participant, now) {
    this.deviceId = deviceId;
    this.participant = participant;
    this.now = now;
    this.messages = [];
    this.outbox = [];
    this.cursor = 0;
  }

  seedOutbound(message, senderSeq) {
    this.messages.push(message);
    this.outbox.push({ messageId: message.id, senderSeq, nextAttemptAt: 0, attempts: 0, blocked: 0, lastError: null, createdAt: message.createdAt });
  }

  async reconcileOutbox() {}

  async getPendingOutbox() {
    return this.outbox.filter((item) => item.blocked === 0);
  }

  async markSynced(messageId) {
    const item = this.messages.find((message) => message.id === messageId);
    if (item) item.syncState = 'SYNCED';
    this.outbox = this.outbox.filter((entry) => entry.messageId !== messageId);
  }

  async markAttemptFailed(messageId, cause, now) {
    const item = this.outbox.find((entry) => entry.messageId === messageId);
    if (!item) return;
    item.attempts += 1;
    item.nextAttemptAt = now + 5_000;
    item.lastError = cause instanceof Error ? cause.message : String(cause);
    const message = this.messages.find((entry) => entry.id === messageId);
    if (message) message.syncState = 'FAILED';
  }

  async markBlocked(messageId, cause) {
    const item = this.outbox.find((entry) => entry.messageId === messageId);
    if (item) {
      item.blocked = 1;
      item.lastError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async getPullCursor() {
    return this.cursor;
  }

  async commitInbound(messages, nextCursor) {
    for (const inbound of messages) {
      if (!this.messages.some((message) => message.id === inbound.id)) {
        this.messages.push({
          id: inbound.id,
          relationshipId: 'the-one',
          participant: 'PARTNER',
          type: inbound.type,
          body: inbound.body,
          createdAt: inbound.createdAt,
          isActive: true,
          syncState: 'SYNCED',
          orderIndex: this.messages.length + 1,
          mediaReference: inbound.mediaReference ?? null,
        });
      }
    }
    this.cursor = nextCursor;
  }
}

function createEngine({ deviceId, participant, relationshipKey, server, now }) {
  const state = new MemoryState(deviceId, participant, now);
  const repository = { getMessages: async () => state.messages };
  const codec = new AesGcmSyncCodec({ relationshipId: 'cloud-relationship', relationshipKey, provider });
  const cloud = server.createClient(deviceId, participant);
  const engine = new SyncEngine({
    cloud,
    state,
    repository,
    codec,
    now,
  });
  return { engine, state };
}

test('two devices exchange encrypted text in both directions and preserve a burst', async () => {
  let now = 1_700_001_000_000;
  const relationshipKey = key();
  const server = new MemoryServer();
  const a = createEngine({ deviceId: 'device-a', participant: 'ME', relationshipKey, server, now: () => now });
  const b = createEngine({ deviceId: 'device-b', participant: 'PARTNER', relationshipKey, server, now: () => now });

  a.state.seedOutbound(message('a-1', 'ME', 'one 🌶️', 1), 1);
  a.state.seedOutbound(message('a-2', 'ME', 'two', 2), 2);
  a.state.seedOutbound(message('a-3', 'ME', 'three', 3), 3);
  a.state.seedOutbound(message('a-4', 'ME', 'four', 4), 4);

  const sent = await a.engine.run();
  assert.equal(sent.pushed, 4);
  assert.equal(a.state.outbox.length, 0);

  const received = await b.engine.run();
  assert.equal(received.pulled, 4);
  assert.deepEqual(
    b.state.messages.filter((item) => item.participant === 'PARTNER').map((item) => item.body),
    ['one 🌶️', 'two', 'three', 'four'],
  );

  b.state.seedOutbound(message('b-1', 'ME', 'reply', 5), 1);
  const replySent = await b.engine.run();
  assert.equal(replySent.pushed, 1);

  const replyReceived = await a.engine.run();
  assert.equal(replyReceived.pulled, 1);
  assert.equal(a.state.messages.find((item) => item.id === 'b-1')?.body, 'reply');
  assert.equal(server.messages.length, 0);

  void now;
});

test('a lost push response is retried without duplicating the server message', async () => {
  let now = 1_700_002_000_000;
  const relationshipKey = key();
  const server = new MemoryServer();
  server.dropNextPushResponse.add('device-a');
  const a = createEngine({ deviceId: 'device-a', participant: 'ME', relationshipKey, server, now: () => now });
  const b = createEngine({ deviceId: 'device-b', participant: 'PARTNER', relationshipKey, server, now: () => now });

  a.state.seedOutbound(message('ambiguous-1', 'ME', 'only once', 1), 1);

  const first = await a.engine.run();
  assert.equal(first.pushed, 0);
  assert.equal(first.failed, 1);
  assert.equal(server.messages.length, 1);
  assert.equal(a.state.outbox.length, 1);

  now += 5_000;
  const second = await a.engine.run();
  assert.equal(second.pushed, 1);
  assert.equal(a.state.outbox.length, 0);
  assert.equal(server.messages.length, 1);

  const received = await b.engine.run();
  assert.equal(received.pulled, 1);
  assert.equal(b.state.messages.filter((item) => item.id === 'ambiguous-1').length, 1);
});
