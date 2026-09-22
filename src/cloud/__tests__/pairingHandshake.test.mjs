import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAIRING_HANDSHAKE_VERSION,
  createPairingHandshake,
  createPairingSessionId,
  derivePairingKeys,
} from '../pairingHandshake.ts';

const CODE = '😀😃😄😁😆';
const WRONG_CODE = '😀😀😀😀😀';
const COMMITMENT = 'a'.repeat(64);
const SESSION_BYTES = new Uint8Array(16).fill(7);

test('CPace initiator and responder derive identical session keys', async () => {
  const sessionId = createPairingSessionId(SESSION_BYTES);
  const initiator = createPairingHandshake(sessionId, CODE, COMMITMENT);
  const responder = createPairingHandshake(sessionId, CODE, COMMITMENT);

  const initiatorKeys = await derivePairingKeys({
    sessionId,
    ephemeralSecret: initiator.ephemeralSecret,
    ownShare: initiator.share,
    role: 'INITIATOR',
    relationshipKeyCommitment: COMMITMENT,
  }, responder.share);

  const responderKeys = await derivePairingKeys({
    sessionId,
    ephemeralSecret: responder.ephemeralSecret,
    ownShare: responder.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, initiator.share);

  assert.equal(initiatorKeys.wrapKey, responderKeys.wrapKey);
  assert.equal(initiatorKeys.confirmKey, responderKeys.confirmKey);
});

test('a wrong five-emoji code cannot derive the same session key', async () => {
  const sessionId = createPairingSessionId(SESSION_BYTES);
  const initiator = createPairingHandshake(sessionId, CODE, COMMITMENT);
  const correctResponder = createPairingHandshake(sessionId, CODE, COMMITMENT);
  const wrongResponder = createPairingHandshake(sessionId, WRONG_CODE, COMMITMENT);

  const correctKeys = await derivePairingKeys({
    sessionId,
    ephemeralSecret: correctResponder.ephemeralSecret,
    ownShare: correctResponder.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, initiator.share);

  const wrongKeys = await derivePairingKeys({
    sessionId,
    ephemeralSecret: wrongResponder.ephemeralSecret,
    ownShare: wrongResponder.share,
    role: 'RESPONDER',
    relationshipKeyCommitment: COMMITMENT,
  }, initiator.share);

  assert.notEqual(wrongKeys.wrapKey, correctKeys.wrapKey);
  assert.notEqual(wrongKeys.confirmKey, correctKeys.confirmKey);
});

test('session identifiers are 16-byte standard Base64 values', () => {
  const sessionId = createPairingSessionId(SESSION_BYTES);
  assert.equal(sessionId, 'BwcHBwcHBwcHBwcHBwcHBQ==');
  assert.equal(Buffer.from(sessionId, 'base64').length, 16);
});

test('handshake version is explicit and stable for the experimental draft-20 suite', () => {
  assert.equal(PAIRING_HANDSHAKE_VERSION, 'rucola-cpace20-v1');
});
