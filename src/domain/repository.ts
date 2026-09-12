import type { Message, MessageType, Relationship } from './models';

export interface RucolaRepository {
  getRelationship(): Promise<Relationship | null>;
  saveSetup(input: {
    partnerNickname: string;
    ownName: string;
    partnerColor?: string;
    togetherSince: number | null;
  }): Promise<void>;
  deleteRelationship(): Promise<void>;
  getMessages(): Promise<Message[]>;
  getActiveMessage(participant: Message['participant']): Promise<Message | null>;
  sendMessage(input: {
    type: MessageType;
    body: string;
    mediaReference?: string | null;
  }): Promise<Message>;
}
