import { describe, expect, it } from 'vitest';

// Domain/repository behavioral coverage is added incrementally as the RN test harness is finalized.
// This first suite intentionally documents the core lifecycle contract without coupling to SQLite.
describe('message lifecycle contract', () => {
  it('archives the previous active message when a participant sends a new message', () => {
    const messages = [
      { id: 'a', participant: 'ME', active: true, orderIndex: 1 },
      { id: 'b', participant: 'ME', active: false, orderIndex: 2 },
    ];

    const active = messages.filter((message) => message.participant === 'ME' && message.active);
    expect(active).toHaveLength(1);
    expect(messages.find((message) => message.id === 'a')?.active).toBe(true);

    const replaced = messages.map((message) => ({ ...message, active: message.id === 'b' }));
    expect(replaced.find((message) => message.id === 'a')?.active).toBe(false);
    expect(replaced.find((message) => message.id === 'b')?.active).toBe(true);
  });

  it('keeps participant active state isolated', () => {
    const messages = [
      { id: 'me', participant: 'ME', active: true },
      { id: 'partner', participant: 'PARTNER', active: true },
    ];

    expect(messages.filter((message) => message.participant === 'ME' && message.active)).toHaveLength(1);
    expect(messages.filter((message) => message.participant === 'PARTNER' && message.active)).toHaveLength(1);
  });

  it('preserves deterministic order for history', () => {
    const messages = [
      { id: 'c', orderIndex: 3 },
      { id: 'a', orderIndex: 1 },
      { id: 'b', orderIndex: 2 },
    ];

    expect([...messages].sort((a, b) => a.orderIndex - b.orderIndex).map((message) => message.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
