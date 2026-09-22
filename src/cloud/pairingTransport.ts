import { isValidPairingConfirmationCode } from './pairingCode.ts';

export const PAIRING_SHARE_BASE_URL = 'https://rucola.njco.dev';

export type PairingTransport = 'EMOJI' | 'SHARE_LINK';

export type PairingInput =
  | { transport: 'EMOJI'; value: string }
  | { transport: 'SHARE_LINK'; value: string };

export interface PairingInvitationView {
  pairingCode: string;
  shareUrl: string;
  expiresAt: number;
}

export function canonicalizePairingCode(value: string): string {
  if (typeof value !== 'string') throw new Error('Pairing code is invalid.');
  const compact = value.replace(/\s/gu, '');
  if (!isValidPairingConfirmationCode(compact)) {
    throw new Error('Pairing code must contain exactly five valid emojis.');
  }
  return Array.from(compact).join('');
}

export function createPairingShareUrl(
  pairingCode: string,
  baseUrl = PAIRING_SHARE_BASE_URL,
): string {
  const canonicalCode = canonicalizePairingCode(pairingCode);
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new Error('Pairing share base URL is invalid.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Pairing share base URL must be a plain HTTPS origin.');
  }
  const normalizedOrigin = origin.origin;
  return normalizedOrigin + '/' + encodeURIComponent(canonicalCode);
}

export function parsePairingShareUrl(value: string, baseUrl = PAIRING_SHARE_BASE_URL): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Pairing share link is invalid.');
  }

  let url: URL;
  let expectedOrigin: URL;
  try {
    url = new URL(value);
    expectedOrigin = new URL(baseUrl);
  } catch {
    throw new Error('Pairing share link is invalid.');
  }

  if (
    expectedOrigin.protocol !== 'https:' ||
    expectedOrigin.username ||
    expectedOrigin.password ||
    expectedOrigin.search ||
    expectedOrigin.hash ||
    url.origin !== expectedOrigin.origin
  ) {
    throw new Error('Pairing share link is invalid.');
  }

  if (url.search || url.hash || url.pathname === '/' || url.pathname.endsWith('/')) {
    throw new Error('Pairing share link is invalid.');
  }

  const encodedCode = url.pathname.slice(1);
  if (encodedCode.includes('/')) {
    throw new Error('Pairing share link is invalid.');
  }

  let decodedCode: string;
  try {
    decodedCode = decodeURIComponent(encodedCode);
  } catch {
    throw new Error('Pairing share link is invalid.');
  }
  if (/\s/gu.test(decodedCode)) {
    throw new Error('Pairing share link is invalid.');
  }

  return canonicalizePairingCode(decodedCode);
}

export function normalizePairingInput(input: PairingInput): { transport: PairingTransport; pairingCode: string } {
  if (input.transport === 'EMOJI') {
    return { transport: 'EMOJI', pairingCode: canonicalizePairingCode(input.value) };
  }
  if (input.transport === 'SHARE_LINK') {
    return { transport: 'SHARE_LINK', pairingCode: parsePairingShareUrl(input.value) };
  }
  throw new Error('Pairing input transport is invalid.');
}

