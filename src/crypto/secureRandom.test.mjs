import assert from 'node:assert/strict';
import test from 'node:test';
import { installSecureRandomSource } from './secureRandom.ts';

test('installs a secure random source when the runtime has crypto without getRandomValues', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalCrypto = globalThis.crypto;

  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
      enumerable: false,
      writable: true,
    });

    const calls = [];
    installSecureRandomSource((array) => {
      calls.push(array.length);
      array.fill(7);
      return array;
    });

    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);

    assert.deepEqual(Array.from(bytes), new Array(16).fill(7));
    assert.deepEqual(calls, [16]);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalDescriptor);
    } else {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  }
});
