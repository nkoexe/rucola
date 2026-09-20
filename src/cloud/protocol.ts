export type CloudParticipant = 'ME' | 'PARTNER';
export type CloudMessageType = 'TEXT' | 'EMOJI' | 'PHOTO_VIDEO' | 'DRAWING';
export type CloudMediaType = 'PHOTO' | 'VIDEO';

export interface PairingBootstrapRequest {
  expiresInSeconds?: number;
  relationshipKeyCommitment: string;
}

export interface PairingBootstrapResponse {
  relationshipId: string;
  invitationId: string;
  deviceId: string;
  participant: 'ME';
  credential: string;
  token: string;
  confirmationCode: string;
  relationshipKeyCommitment: string;
  expiresAt: number;
}

export interface PairingCreateResponse {
  relationshipId: string;
  invitationId: string;
  token: string;
  confirmationCode: string;
  relationshipKeyCommitment: string;
  expiresAt: number;
}

export interface PairingAcceptRequest {
  token: string;
  confirmationCode: string;
  relationshipKeyCommitment: string;
}

export interface PairingAcceptResponse {
  relationshipId: string;
  deviceId: string;
  participant: 'PARTNER';
  credential: string;
  relationshipKeyCommitment: string;
}

export type CloudRelationshipStatus = 'PAIRING' | 'ACTIVE' | 'ENDED';

export interface AuthProbeResponse {
  authenticated: true;
  participant: CloudParticipant;
  relationshipStatus: CloudRelationshipStatus;
}

export interface CloudPushMessage {
  messageId: string;
  senderSeq: number;
  type: CloudMessageType;
  ciphertext: string;
  encryptionVersion: number;
  createdAt: number;
  mediaUploadId?: string | null;
}

export interface CloudPushResponse {
  messageId: string;
  senderSeq: number;
  serverSeq: number;
  acceptedAt: number;
}

export interface CloudPulledMessage {
  messageId: string;
  senderDeviceId: string;
  senderParticipant: CloudParticipant;
  senderSeq: number;
  createdAt: number;
  serverSeq: number;
  receivedAt: number;
  type: CloudMessageType;
  ciphertext: string;
  encryptionVersion: number;
  mediaUploadId: string | null;
}

export interface CloudPullResponse {
  messages: CloudPulledMessage[];
  nextCursor: number;
  hasMore: boolean;
}

export interface CloudAckResponse {
  acknowledgedThrough: number;
  deleted: number;
  acknowledgedAt: number;
}

export interface CreateMediaReservationRequest {
  type: CloudMediaType;
  mime: string;
  size: number;
  checksum?: string | null;
}

export interface CreateMediaReservationResponse {
  uploadId: string;
  mediaType: CloudMediaType;
  mime: string;
  size: number;
  checksum: string | null;
  status: 'PENDING';
  expiresAt: number;
}

export interface MediaUploadResponse {
  uploadId: string;
  status: 'UPLOADED';
}

export interface CompleteMediaResponse {
  uploadId: string;
  status: 'READY';
}
