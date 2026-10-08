import { sha256Hex } from "./auth";
import { json, errorResponse } from "./http";
import type { AuthenticatedDevice, Env, Participant } from "./types";

const DEFAULT_INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const CREDENTIAL_BYTES = 32;
const MAX_JSON_BODY_BYTES = 16 * 1024;

interface PairingBootstrapRequest { expiresInSeconds?: unknown; relationshipKeyCommitment?: unknown; }

function randomToken(byteLength: number): string { const bytes = new Uint8Array(byteLength); crypto.getRandomValues(bytes); return base64Url(bytes); }
function base64Url(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function randomId(): string { return crypto.randomUUID(); }
const PAIRING_EMOJIS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
  "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰",
  "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪",
  "😎", "🤩", "🥳", "🤗", "🤔", "🥺", "😭", "😡",
  "😴",
] as const;

function randomPairingEmoji(): string {
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / PAIRING_EMOJIS.length) * PAIRING_EMOJIS.length;
  const bytes = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0] ?? 0;
  } while (value >= limit);
  return PAIRING_EMOJIS[value % PAIRING_EMOJIS.length];
}

function randomConfirmationCode(): string {
  return Array.from({ length: 5 }, () => randomPairingEmoji()).join("");
}


function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function parseJsonObject(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null; }
function isJsonContentType(request: Request): boolean { const contentType = request.headers.get("content-type"); return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"; }
async function readJson<T extends object>(request: Request): Promise<T | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) { const parsedLength = Number(contentLength); if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BODY_BYTES) return null; }
  if (!request.body) return null;
  try { const body = new Uint8Array(await request.arrayBuffer()); if (body.byteLength > MAX_JSON_BODY_BYTES) return null; return parseJsonObject(JSON.parse(new TextDecoder().decode(body))) as T | null; } catch { return null; }
}
function invitationLifetime(body: PairingBootstrapRequest | null): number {
  if (!body) return 0;
  if (body.expiresInSeconds === undefined) return DEFAULT_INVITATION_LIFETIME_MS;
  if (typeof body.expiresInSeconds !== "number" || !Number.isFinite(body.expiresInSeconds)) return 0;
  const seconds = Math.floor(body.expiresInSeconds); if (seconds <= 0) return 0;
  return Math.min(seconds * 1000, MAX_INVITATION_LIFETIME_MS);
}




export async function bootstrapPairing(env: Env, request: Request): Promise<Response> {
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);
  const body = await readJson<PairingBootstrapRequest>(request); const lifetime = invitationLifetime(body); if (lifetime <= 0 || !isSha256Hex(body?.relationshipKeyCommitment)) return errorResponse("INVALID_REQUEST", "Invalid pairing request", 400);
  const relationshipId = randomId(); const deviceId = randomId(); const invitationId = randomId(); const credential = randomToken(CREDENTIAL_BYTES); const token = randomToken(TOKEN_BYTES); const confirmationCode = randomConfirmationCode();
  const credentialHash = await sha256Hex(credential); const tokenHash = await sha256Hex(token); const confirmationCodeHash = await sha256Hex(confirmationCode); const now = Date.now(); const expiresAt = now + lifetime;
  try { await env.DB.batch([
    env.DB.prepare(`INSERT INTO relationships (id, status, next_server_seq, created_at, relationship_key_commitment) VALUES (?1, 'PAIRING', 1, ?2, ?3)`).bind(relationshipId, now, body?.relationshipKeyCommitment),
    env.DB.prepare(`INSERT INTO devices (id, relationship_id, participant, credential_hash, created_at, last_seen_at) VALUES (?1, ?2, 'ME', ?3, ?4, ?4)`).bind(deviceId, relationshipId, credentialHash, now),
    env.DB.prepare(`INSERT INTO invitations (id, relationship_id, token_hash, confirmation_code_hash, created_by_device_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(invitationId, relationshipId, tokenHash, confirmationCodeHash, deviceId, now, expiresAt),
  ]); } catch { return errorResponse("INTERNAL_ERROR", "Pairing could not be initialized", 500); }
  return json({ relationshipId, invitationId, deviceId, participant:"ME" satisfies Participant, credential, token, confirmationCode, relationshipKeyCommitment: body?.relationshipKeyCommitment, expiresAt }, 201);
}
