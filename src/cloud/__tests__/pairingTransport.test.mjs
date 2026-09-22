import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAIRING_SHARE_BASE_URL,
  canonicalizePairingCode,
  createPairingShareUrl,
  normalizePairingInput,
  parsePairingShareUrl,
  parsePairingAppLink,
  parsePairingDeepLink,
} from '../pairingTransport.ts';

const CODE = '😀😃😄😁😆';

test('canonicalizes the human pairing code without changing its symbols', () => {
  assert.equal(canonicalizePairingCode(' 😀 😃😄\n😁😆 '), CODE);
  assert.equal(canonicalizePairingCode(CODE), CODE);
});

test('rejects malformed pairing codes', () => {
  assert.throws(() => canonicalizePairingCode('😀😃😄😁'), /exactly five/);
  assert.throws(() => canonicalizePairingCode('😀😃😄😁😆😴'), /exactly five/);
  assert.throws(() => canonicalizePairingCode('😀😃😄😁💚'), /exactly five/);
});

test('builds a user-facing HTTPS share URL with only the pairing code', () => {
  const url = createPairingShareUrl(CODE);
  assert.equal(url, PAIRING_SHARE_BASE_URL + '/%F0%9F%98%80%F0%9F%98%83%F0%9F%98%84%F0%9F%98%81%F0%9F%98%86');
  assert(!url.includes('rucola-pairing:v1.'));
  assert(!url.includes('relationship'));
  assert(!url.includes('token'));
});

test('parses an encoded share URL exactly once', () => {
  const url = createPairingShareUrl(CODE);
  assert.equal(parsePairingShareUrl(url), CODE);
  assert.equal(parsePairingShareUrl(PAIRING_SHARE_BASE_URL + '/' + encodeURIComponent(CODE)), CODE);
});

test('accepts direct emoji input and link input through the same boundary', () => {
  assert.deepEqual(normalizePairingInput({ transport: 'EMOJI', value: ' ' + CODE + ' ' }), {
    transport: 'EMOJI',
    pairingCode: CODE,
  });
  assert.deepEqual(normalizePairingInput({ transport: 'SHARE_LINK', value: createPairingShareUrl(CODE) }), {
    transport: 'SHARE_LINK',
    pairingCode: CODE,
  });
});

test('rejects unsafe share-link variations', () => {
  const cases = [
    PAIRING_SHARE_BASE_URL + '/',
    PAIRING_SHARE_BASE_URL + '/' + encodeURIComponent(CODE) + '?x=1',
    PAIRING_SHARE_BASE_URL + '/' + encodeURIComponent(CODE) + '#x',
    'https://example.com/' + encodeURIComponent(CODE),
    PAIRING_SHARE_BASE_URL + '/' + encodeURIComponent(CODE) + '/extra',
    PAIRING_SHARE_BASE_URL + '/not%20a%20pairing%20code',
  ];

  for (const value of cases) {
    assert.throws(() => parsePairingShareUrl(value), /Pairing share link is invalid/);
  }
});

test('rejects a pairing base URL with a path', () => {
  assert.throws(
    () => createPairingShareUrl(CODE, PAIRING_SHARE_BASE_URL + '/pair'),
    /plain HTTPS origin/,
  );
});

test('parses the website fallback custom app link through the same normalization boundary', () => {
  const appLink = 'rucola://pair/' + encodeURIComponent(CODE);
  assert.equal(parsePairingAppLink(appLink), CODE);
  assert.equal(parsePairingDeepLink(appLink), CODE);
});

test('rejects unsafe custom app links', () => {
  assert.throws(() => parsePairingAppLink('rucola://pair/' + encodeURIComponent(CODE) + '?x=1'));
  assert.throws(() => parsePairingAppLink('rucola://other/' + encodeURIComponent(CODE)));
  assert.throws(() => parsePairingAppLink('rucola://pair/' + encodeURIComponent(CODE) + '/extra'));
});
