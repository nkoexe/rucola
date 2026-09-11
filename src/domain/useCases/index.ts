import type { Message, MessageType, Relationship } from '../models';
import type { RucolaRepository } from '../../data/repositories/RucolaRepository';

export class SaveSetup {
  constructor(private readonly repository: RucolaRepository) {}

  execute(input: {
    partnerNickname: string;
    ownName: string;
    partnerColor?: string;
    togetherSince?: string | null;
  }): Promise<void> {
    return this.repository.saveSetup(input);
  }
}

export class SendMessage {
  constructor(private readonly repository: RucolaRepository) {}

  execute(input: {
    type: MessageType;
    body?: string;
    mediaReference?: string | null;
  }): Promise<Message> {
    return this.repository.sendMessage(input);
  }
}

export class GetRelationship {
  constructor(private readonly repository: RucolaRepository) {}

  execute(): Promise<Relationship | null> {
    return this.repository.getRelationship();
  }
}

export class GetMessages {
  constructor(private readonly repository: RucolaRepository) {}

  execute(): Promise<Message[]> {
    return this.repository.getMessages();
  }
}
