import type { Message, MessageType, Participant, Relationship } from '../models';
import type { RucolaRepository } from '../repository';

export class SaveSetup {
  private readonly repository: RucolaRepository;

  constructor(repository: RucolaRepository) {
    this.repository = repository;
  }

  execute(input: {
    partnerNickname: string;
    ownName: string;
    partnerColor?: string;
    togetherSince: number | null;
  }): Promise<void> {
    const partnerNickname = input.partnerNickname.trim();
    const ownName = input.ownName.trim();

    if (!partnerNickname || !ownName) {
      return Promise.reject(new Error('Both names are required.'));
    }

    if (input.togetherSince !== null && !Number.isFinite(input.togetherSince)) {
      return Promise.reject(new Error('Together-since date is invalid.'));
    }

    return this.repository.saveSetup({
      ...input,
      partnerNickname,
      ownName,
    });
  }
}

export class SendMessage {
  private readonly repository: RucolaRepository;

  constructor(repository: RucolaRepository) {
    this.repository = repository;
  }

  execute(input: {
    type: MessageType;
    body?: string;
    mediaReference?: string | null;
  }): Promise<Message> {
    const body = input.body?.trim() ?? '';
    const mediaReference = input.mediaReference?.trim() || null;

    if ((input.type === 'TEXT' || input.type === 'EMOJI') && !body) {
      return Promise.reject(new Error('This message type requires content.'));
    }

    if ((input.type === 'PHOTO_VIDEO' || input.type === 'DRAWING') && !mediaReference) {
      return Promise.reject(new Error('This message type requires media.'));
    }

    return this.repository.sendMessage({
      ...input,
      body,
      mediaReference,
    });
  }
}

export class GetRelationship {
  private readonly repository: RucolaRepository;

  constructor(repository: RucolaRepository) {
    this.repository = repository;
  }

  execute(): Promise<Relationship | null> {
    return this.repository.getRelationship();
  }
}

export class GetMessages {
  private readonly repository: RucolaRepository;

  constructor(repository: RucolaRepository) {
    this.repository = repository;
  }

  execute(): Promise<Message[]> {
    return this.repository.getMessages();
  }
}

export class GetActiveMessage {
  private readonly repository: RucolaRepository;

  constructor(repository: RucolaRepository) {
    this.repository = repository;
  }

  execute(participant: Participant): Promise<Message | null> {
    return this.repository.getActiveMessage(participant);
  }
}

export class DeleteRelationship {
  private readonly repository: RucolaRepository;

  constructor(repository: RucolaRepository) {
    this.repository = repository;
  }

  execute(): Promise<void> {
    return this.repository.deleteRelationship();
  }
}
