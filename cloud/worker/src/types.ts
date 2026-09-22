export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  PAIRING_BOOTSTRAP_LIMITER: RateLimit;
  RUCOLA_ANDROID_APP_LINK_FINGERPRINTS?: string;
}

export type Participant = "ME" | "PARTNER";

export type MessageType =
  | "TEXT"
  | "EMOJI"
  | "PHOTO_VIDEO"
  | "DRAWING";

export interface AuthenticatedDevice {
  id: string;
  relationshipId: string;
  participant: Participant;
}
