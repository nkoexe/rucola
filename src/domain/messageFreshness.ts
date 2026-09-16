import type { Message } from './models';

/** A partner message is considered stale after three days without a newer message. */
export const PARTNER_MESSAGE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function isPartnerMessageStale(message: Message | null, now: number): boolean {
  if (!message || !Number.isFinite(now) || !Number.isFinite(message.createdAt)) {
    return false;
  }

  const age = now - message.createdAt;
  return age >= PARTNER_MESSAGE_MAX_AGE_MS;
}
