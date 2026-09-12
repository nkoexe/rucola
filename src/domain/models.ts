export type Participant = 'ME' | 'PARTNER';

export type MessageType = 'TEXT' | 'EMOJI' | 'PHOTO_VIDEO' | 'DRAWING';

export type SyncState = 'LOCAL_ONLY' | 'PENDING' | 'SYNCED' | 'FAILED';

export interface Relationship {
  id: string;
  partnerNickname: string;
  ownName: string;
  partnerColor: string;
  togetherSince: number | null;
}

export interface Message {
  id: string;
  relationshipId: string;
  participant: Participant;
  type: MessageType;
  body: string;
  createdAt: number;
  isActive: boolean;
  syncState: SyncState;
  orderIndex: number;
  mediaReference: string | null;
}
