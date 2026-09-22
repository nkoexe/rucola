import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToBase64, utf8Encode } from '../../src/crypto/encoding.ts';
import { createPairingHandshake, derivePairingKeys } from './pairingHandshake.ts';

const CODE = '😀😃😄😁😆';
const COMMITMENT = 'a'.repeat(64);
const SESSION = bytesToBase64(new Uint8Array(16).fill(7));

test('both CPace peers derive the same pairing keys', async () => {
  const a = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const b = await createPairingHandshake(SESSION, CODE, COMMITMENT);

  const aKeys = await derivePairingKeys({
    sessionId: SESSION,
    ephemeralSecret: a.ephemeralSecret,
    ownShare: a.share,
    role: 'INITIATOR',
    relationshipKeyCommitment: COMMITMENT,
  }, b.share);
  const bKeys = await derivePairingKeys({
    sessionId: SESSION,
    ephemeralSecret: b.ephemeralSecret,
    ownShare: b.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, a.share);

  assert.equal(aKeys.wrapKey, bKeys.wrapKey);
  assert.equal(aKeys.confirmKey, bKeys.confirmKey);
});

test('wrong pairing code produces a different CPace session', async () => {
  const initiator = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const correctResponder = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const wrongResponder = await createPairingHandshake(SESSION, '😀😀😀😀😀', COMMITMENT);

  const correct = await derivePairingKeys({
    sessionId: SESSION,
    ephemeralSecret: correctResponder.ephemeralSecret,
    ownShare: correctResponder.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, initiator.share);
  const wrong = await derivePairingKeys({
    sessionId: SESSION,
    ephemeralSecret: wrongResponder.ephemeralSecret,
    ownShare: wrongResponder.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, initiator.share);

  assert.notEqual(wrong.wrapKey, correct.wrapKey);
  assert.notEqual(wrong.confirmKey, correct.confirmKey);
});

test('session IDs are part of CPace key derivation', async () => {
  const a = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const b = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const different = bytesToBase64(new Uint8Array(16).fill(8));
  const c = await createPairingHandshake(different, CODE, COMMITMENT);
  const k1 = await derivePairingKeys({
    sessionId: SESSION, ephemeralSecret: a.ephemeralSecret, ownShare: a.share, role: 'INITIATOR', relationshipKeyCommitment: COMMITMENT
  }, b.share);
  const k2 = await derivePairingKeys({
    sessionId: different, ephemeralSecret: c.ephemeralSecret, ownShare: c.share, role: 'RESPONDER', relationshipKeyCommitment: COMMITMENT
  }, a.share);
  assert.notEqual(k1.wrapKey, k2.wrapKey);
});
