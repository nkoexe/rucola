import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

globalThis.window = {};
globalThis.document = {};

const { generateRelationshipKey, normalizeRelationshipKey } = await import('./relationshipKey.ts');
const { relationshipKeyCommitment } = await import('../cloud/pairing.ts');

test('generates a 256-bit relationship key through browser Web Crypto', async () => {
  const key = await generateRelationshipKey();
  assert.match(key, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/);
  assert.equal(Buffer.from(key, 'base64').byteLength, 32);
  assert.equal(await normalizeRelationshipKey(key), key);
});

test('computes the relationship key commitment through browser Web Crypto', async () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const commitment = await relationshipKeyCommitment(key);
  const digest = await webcrypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('rucola-e2e-key-v1:' + key),
  );
  assert.equal(commitment, Buffer.from(digest).toString('hex'));
});
