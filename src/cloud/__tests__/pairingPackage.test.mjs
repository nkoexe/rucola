import assert from 'node:assert/strict';
import test from 'node:test';
import { createPairingPackage, decodePairingPackage, PAIRING_PROTOCOL_VERSION } from '../pairingPackage.ts';

const RESPONSE = {
  relationshipId: 'relationship-1',
  invitationId: 'invitation-1',
  deviceId: 'device-1',
  participant: 'ME',
  credential: 'credential-1',
  token: 'a'.repeat(43),
  confirmationCode: '😀😃😄😁😆',
  relationshipKeyCommitment: 'a'.repeat(64),
  expiresAt: 4_000_000_000_000,
};

const KEY = Buffer.alloc(32, 7).toString('base64');

test('pairing package round-trips without the human confirmation code', async () => {
  const encoded = await createPairingPackage(RESPONSE, KEY);
  assert.match(encoded, /^rucola-pairing:v1\./);
  assert(!encoded.includes(RESPONSE.confirmationCode));
  const decoded = await decodePairingPackage(encoded, 1_000_000_000_000);
  assert.deepEqual(decoded, {
    version: PAIRING_PROTOCOL_VERSION,
    relationshipId: RESPONSE.relationshipId,
    invitationId: RESPONSE.invitationId,
    token: RESPONSE.token,
    expiresAt: RESPONSE.expiresAt,
    relationshipKey: KEY,
  });
});

test('pairing package canonicalizes the relationship key', async () => {
  const keyWithPadding = Buffer.alloc(32, 9).toString('base64');
  const encoded = await createPairingPackage(RESPONSE, keyWithPadding);
  const decoded = await decodePairingPackage(encoded, 1_000_000_000_000);
  assert.equal(decoded.relationshipKey, keyWithPadding);
});

test('pairing package rejects expired payloads', async () => {
  const encoded = await createPairingPackage({ ...RESPONSE, expiresAt: 2_000 }, KEY);
  await assert.rejects(() => decodePairingPackage(encoded, 2_001), /Pairing package is invalid/);
});

test('pairing package rejects tampered payloads', async () => {
  const encoded = await createPairingPackage(RESPONSE, KEY);
  const last = encoded.at(-1);
  const tampered = encoded.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  await assert.rejects(() => decodePairingPackage(tampered, 1_000_000_000_000), /Pairing package is invalid/);
});

test('pairing package rejects unsupported protocol versions', async () => {
  const encoded = await createPairingPackage(RESPONSE, KEY);
  const payload = encoded.slice('rucola-pairing:v1.'.length);
  const bytes = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const object = JSON.parse(bytes.toString('utf8'));
  object.version = 2;
  const changed = 'rucola-pairing:v1.' + Buffer.from(JSON.stringify(object)).toString('base64url');
  await assert.rejects(() => decodePairingPackage(changed, 1_000_000_000_000), /Pairing package is invalid/);
});