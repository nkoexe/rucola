export type Participant = 'me' | 'partner';

export type MessageType = 'text' | 'emoji' | 'photo' | 'video' | 'drawing';

export interface Relationship {
  id: string;
  partnerNickname: string;
  ownName: string;
  togetherSince: string | null;
}

export interface Message {
  id: string;
  participant: Participant;
  type: MessageType;
  body: string | null;
  createdAt: string;
  isActive: boolean;
}
