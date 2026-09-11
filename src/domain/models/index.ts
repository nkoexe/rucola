export type Participant = 'me' | 'partner';

export type MessageType = 'text' | 'emoji' | 'photo' | 'video' | 'drawing';

export type SyncState = 'local-only' | 'pending' | 'synced' | 'failed';

export interface Relationship {
  id: string;
  partnerNickname: string;
  ownName: string;
  partnerColor: string;
  togetherSince: string | null;
}

export interface Message {
  id: string;
  relationshipId: string;
  participant: Participant;
  type: MessageType;
  body: string;
  createdAt: string;
  orderIndex: number;
  isActive: boolean;
  syncState: SyncState;
  mediaReference: string | null;
}
