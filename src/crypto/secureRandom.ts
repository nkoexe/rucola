type RandomValues = (array: Uint8Array) => Uint8Array;

type RuntimeCrypto = {
  getRandomValues?: RandomValues;
};

type RuntimeGlobal = {
  crypto?: RuntimeCrypto;
};

export function installSecureRandomSource(getRandomValues: RandomValues): void {
  const runtime = globalThis as unknown as RuntimeGlobal;

  if (runtime.crypto?.getRandomValues) return;

  const current = runtime.crypto;
  if (current) {
    try {
      current.getRandomValues = getRandomValues;
    } catch {
      // Some runtimes expose a non-extensible crypto object.
    }
  }

  if (runtime.crypto?.getRandomValues) return;

  const replacement = Object.create(current ?? null) as RuntimeCrypto;
  Object.defineProperty(replacement, 'getRandomValues', {
    value: getRandomValues,
    configurable: true,
    enumerable: true,
    writable: false,
  });

  try {
    Object.defineProperty(runtime, 'crypto', {
      value: replacement,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    // The caller below reports the missing capability with a useful error.
  }

  if (!runtime.crypto?.getRandomValues) {
    throw new Error('Secure random number generation is unavailable on this device.');
  }
}

export async function ensureSecureRandomSource(): Promise<void> {
  const runtime = globalThis as RuntimeGlobal;
  if (runtime.crypto?.getRandomValues) return;

  const { getRandomValues } = await import('expo-crypto');
  installSecureRandomSource(getRandomValues as RandomValues);
}

export async function secureRandomBytes(length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024) {
    throw new Error('Secure random byte length is invalid.');
  }

  await ensureSecureRandomSource();
  const runtime = globalThis as RuntimeGlobal;
  const random = runtime.crypto?.getRandomValues;
  if (!random) {
    throw new Error('Secure random number generation is unavailable on this device.');
  }
  return random(new Uint8Array(length));
}
