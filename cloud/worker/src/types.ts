export interface Env {
  DB: D1Database;
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
