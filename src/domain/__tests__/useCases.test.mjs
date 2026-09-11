import assert from 'node:assert/strict';
import test from 'node:test';

import { SaveSetup, SendMessage } from '../useCases/index.ts';

function createRepositoryMock() {
  const calls = [];
  return {
    calls,
    async saveSetup(input) {
      calls.push({ method: 'saveSetup', input });
    },
    async sendMessage(input) {
      calls.push({ method: 'sendMessage', input });
      return {
        id: 'test-message',
        relationshipId: 'the-one',
        participant: 'ME',
        type: input.type,
        body: input.body,
        createdAt: 1,
        isActive: true,
        syncState: 'PENDING',
        orderIndex: 1,
        mediaReference: input.mediaReference ?? null,
      };
    },
  };
}

test('SaveSetup trims names before persistence', async () => {
  const repository = createRepositoryMock();
  const useCase = new SaveSetup(repository);

  await useCase.execute({
    partnerNickname: '  Partner  ',
    ownName: '  Nico  ',
    togetherSince: null,
  });

  assert.deepEqual(repository.calls[0], {
    method: 'saveSetup',
    input: {
      partnerNickname: 'Partner',
      ownName: 'Nico',
      togetherSince: null,
    },
  });
});

test('SaveSetup rejects blank names', async () => {
  const repository = createRepositoryMock();
  const useCase = new SaveSetup(repository);

  await assert.rejects(
    useCase.execute({ partnerNickname: '   ', ownName: 'Nico', togetherSince: null }),
    { message: 'Both names are required.' },
  );
});

test('SaveSetup rejects non-finite dates', async () => {
  const repository = createRepositoryMock();
  const useCase = new SaveSetup(repository);

  await assert.rejects(
    useCase.execute({ partnerNickname: 'Partner', ownName: 'Nico', togetherSince: Number.NaN }),
    { message: 'Together-since date is invalid.' },
  );
});

test('SendMessage trims text and preserves normalized media references', async () => {
  const repository = createRepositoryMock();
  const useCase = new SendMessage(repository);

  await useCase.execute({
    type: 'TEXT',
    body: '  hello  ',
    mediaReference: '  file:///media/photo.jpg  ',
  });

  assert.deepEqual(repository.calls[0], {
    method: 'sendMessage',
    input: {
      type: 'TEXT',
      body: 'hello',
      mediaReference: 'file:///media/photo.jpg',
    },
  });
});

test('SendMessage rejects empty text and emoji content', async () => {
  const repository = createRepositoryMock();
  const useCase = new SendMessage(repository);

  for (const type of ['TEXT', 'EMOJI']) {
    await assert.rejects(useCase.execute({ type, body: '   ' }), {
      message: 'This message type requires content.',
    });
  }
});

test('SendMessage rejects media messages without media', async () => {
  const repository = createRepositoryMock();
  const useCase = new SendMessage(repository);

  for (const type of ['PHOTO_VIDEO', 'DRAWING']) {
    await assert.rejects(useCase.execute({ type, body: '' }), {
      message: 'This message type requires media.',
    });
  }
});

test('SendMessage accepts media-only messages', async () => {
  const repository = createRepositoryMock();
  const useCase = new SendMessage(repository);

  await useCase.execute({ type: 'PHOTO_VIDEO', mediaReference: '  file:///media/video.mp4 ' });

  assert.equal(repository.calls[0].input.body, '');
  assert.equal(repository.calls[0].input.mediaReference, 'file:///media/video.mp4');
});
