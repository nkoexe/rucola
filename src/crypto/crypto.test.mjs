import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { AesGcmSyncCodec, CryptoDecryptionError } from './messageCodec.ts';
import { base64UrlToBytes, bytesToBase64, bytesToBase64Url } from './encoding.ts';

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
    sealed.set(parts.ciphertext, 0);
    sealed.set(parts.tag, parts.ciphertext.length);
    return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: parts.iv, additionalData, tagLength: 128 }, key, sealed));
  },
};

function key() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

function message(overrides = {}) {
  return {
    id: 'message-1',
    relationshipId: 'relationship-1',
    participant: 'ME',
    type: 'TEXT',
    body: 'Hello 🌶️',
    createdAt: 1_700_000_000_000,
    isActive: true,
    syncState: 'PENDING',
    orderIndex: 1,
    mediaReference: null,
    ...overrides,
  };
}

test('AES-GCM codec round-trips Unicode text', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  const ciphertext = await codec.encrypt(message(), 7);
  const decoded = await codec.decrypt({ messageId: 'message-1', senderSeq: 7, type: 'TEXT', encryptionVersion: 1, ciphertext });
  assert.deepEqual(decoded, { type: 'TEXT', body: 'Hello 🌶️', mediaReference: null });
});

test('AES-GCM uses a fresh nonce for every encryption', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  const first = await codec.encrypt(message(), 7);
  const second = await codec.encrypt(message(), 7);
  assert.notEqual(first.split('.')[1], second.split('.')[1]);
});

test('tampered ciphertext is rejected', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  const ciphertext = await codec.encrypt(message(), 7);
  const parts = ciphertext.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  await assert.rejects(
    () => codec.decrypt({ messageId: 'message-1', senderSeq: 7, type: 'TEXT', encryptionVersion: 1, ciphertext: parts.join('.') }),
    (error) => error instanceof CryptoDecryptionError,
  );
});

test('tampered authenticated context is rejected', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  const ciphertext = await codec.encrypt(message(), 7);
  await assert.rejects(
    () => codec.decrypt({ messageId: 'message-1', senderSeq: 8, type: 'TEXT', encryptionVersion: 1, ciphertext }),
    (error) => error instanceof CryptoDecryptionError,
  );
});

test('wrong relationship key is rejected', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  const ciphertext = await codec.encrypt(message(), 7);
  const other = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  await assert.rejects(
    () => other.decrypt({ messageId: 'message-1', senderSeq: 7, type: 'TEXT', encryptionVersion: 1, ciphertext }),
    (error) => error instanceof CryptoDecryptionError,
  );
});

test('unsupported encrypted message types are rejected for prototype v1', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  await assert.rejects(
    () => codec.encrypt(message({ type: 'PHOTO_VIDEO', body: '', mediaReference: 'rucola-media://photo' }), 1),
    /not supported/,
  );
});

test('malformed envelopes are rejected', async () => {
  const codec = new AesGcmSyncCodec({ relationshipId: 'relationship-1', relationshipKey: key(), provider });
  await assert.rejects(
    () => codec.decrypt({ messageId: 'message-1', senderSeq: 1, type: 'TEXT', encryptionVersion: 1, ciphertext: 'v1.bad.bad.bad' }),
    (error) => error instanceof CryptoDecryptionError,
  );
});

test('base64url encoding round-trips arbitrary bytes', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(base64UrlToBytes(bytesToBase64Url(bytes)), bytes);
  assert.equal(Buffer.from(bytesToBase64Url(bytes), 'base64url').toString('base64'), bytesToBase64(bytes));
});
