import type { Message, MessageType, Relationship } from '../../domain/models';

export interface RucolaRepository {
  getRelationship(): Promise<Relationship | null>;
  saveSetup(input: {
    partnerNickname: string;
    ownName: string;
    partnerColor?: string;
    togetherSince?: string | null;
  }): Promise<void>;
  getMessages(): Promise<Message[]>;
  getActiveMessage(participant: 'me' | 'partner'): Promise<Message | null>;
  sendMessage(input: {
    type: MessageType;
    body?: string;
    mediaReference?: string | null;
  }): Promise<Message>;
}
