import assert from 'node:assert/strict';
import test from 'node:test';

import { isPartnerMessageStale, PARTNER_MESSAGE_MAX_AGE_MS } from '../messageFreshness.ts';

function message(createdAt) {
  return { createdAt };
}

test('partner message is fresh before three days', () => {
  const createdAt = 1_000_000;
  assert.equal(isPartnerMessageStale(message(createdAt), createdAt + PARTNER_MESSAGE_MAX_AGE_MS - 1), false);
});

test('partner message becomes stale exactly at three days', () => {
  const createdAt = 1_000_000;
  assert.equal(isPartnerMessageStale(message(createdAt), createdAt + PARTNER_MESSAGE_MAX_AGE_MS), true);
});

test('future-dated partner message is not stale', () => {
  const createdAt = 2_000_000;
  assert.equal(isPartnerMessageStale(message(createdAt), createdAt - 1), false);
});

test('missing message is never stale', () => {
  assert.equal(isPartnerMessageStale(null, Date.now()), false);
});

test('invalid timestamps do not produce a stale state', () => {
  assert.equal(isPartnerMessageStale(message(Number.NaN), Date.now()), false);
  assert.equal(isPartnerMessageStale(message(Date.now()), Number.NaN), false);
});
