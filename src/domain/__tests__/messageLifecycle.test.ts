function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function runMessageLifecycleContractTests(): void {
  const messages = [
    { id: 'a', participant: 'ME', active: true, orderIndex: 1 },
    { id: 'b', participant: 'ME', active: false, orderIndex: 2 },
  ];

  assert(
    messages.filter((message) => message.participant === 'ME' && message.active).length === 1,
    'expected one active ME message',
  );

  const replaced = messages.map((message) => ({ ...message, active: message.id === 'b' }));
  assert(replaced.find((message) => message.id === 'a')?.active === false, 'previous active message must be archived');
  assert(replaced.find((message) => message.id === 'b')?.active === true, 'new message must become active');

  const participants = [
    { id: 'me', participant: 'ME', active: true },
    { id: 'partner', participant: 'PARTNER', active: true },
  ];
  assert(
    participants.filter((message) => message.participant === 'ME' && message.active).length === 1,
    'ME active state must be isolated',
  );
  assert(
    participants.filter((message) => message.participant === 'PARTNER' && message.active).length === 1,
    'PARTNER active state must be isolated',
  );

  const ordered = [
    { id: 'c', orderIndex: 3 },
    { id: 'a', orderIndex: 1 },
    { id: 'b', orderIndex: 2 },
  ].sort((a, b) => a.orderIndex - b.orderIndex);
  assert(
    JSON.stringify(ordered.map((message) => message.id)) === JSON.stringify(['a', 'b', 'c']),
    'history ordering must be deterministic',
  );
}
