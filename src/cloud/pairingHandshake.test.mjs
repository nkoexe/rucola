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

  const aKeys = await derivePairingKeys(CODE, {
    sessionId: SESSION,
    ephemeralSecret: a.ephemeralSecret,
    ownShare: a.share,
    role: 'INITIATOR',
    relationshipKeyCommitment: COMMITMENT,
  }, b.share);
  const bKeys = await derivePairingKeys(CODE, {
    sessionId: SESSION,
    ephemeralSecret: b.ephemeralSecret,
    ownShare: b.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, a.share);

  assert.equal(aKeys.wrapKey, bKeys.wrapKey);
  assert.equal(aKeys.confirmKey, bKeys.confirmKey);
});

test('wrong pairing code derives different keys', async () => {
  const a = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const b = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  await assert.rejects(
    derivePairingKeys('😀😀😀😀😀', {
      sessionId: SESSION,
      ephemeralSecret: b.ephemeralSecret,
      ownShare: b.share,
      role: 'RESPONDER',
      relationshipKeyCommitment: COMMITMENT,
    }, a.share),
    /./,
  );
});

test('session IDs are part of CPace key derivation', async () => {
  const a = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const b = await createPairingHandshake(SESSION, CODE, COMMITMENT);
  const different = bytesToBase64(new Uint8Array(16).fill(8));
  const c = await createPairingHandshake(different, CODE, COMMITMENT);
  const k1 = await derivePairingKeys(CODE, {
    sessionId: SESSION, ephemeralSecret: a.ephemeralSecret, ownShare: a.share, role: 'INITIATOR', relationshipKeyCommitment: COMMITMENT
  }, b.share);
  const k2 = await derivePairingKeys(CODE, {
    sessionId: different, ephemeralSecret: c.ephemeralSecret, ownShare: c.share, role: 'RESPONDER', relationshipKeyCommitment: COMMITMENT
  }, a.share);
  assert.notEqual(k1.wrapKey, k2.wrapKey);
});
