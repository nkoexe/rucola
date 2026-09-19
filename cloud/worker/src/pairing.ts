import { sha256Hex } from "./auth";
import { json, errorResponse } from "./http";
import type { AuthenticatedDevice, Env, Participant } from "./types";

const DEFAULT_INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const CREDENTIAL_BYTES = 32;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_CONFIRMATION_ATTEMPTS = 5;
const CONFIRMATION_LOCKOUT_MS = 15 * 60 * 1000;

interface InvitationRequest { expiresInSeconds?: unknown; }
interface PairingBootstrapRequest { expiresInSeconds?: unknown; relationshipKeyCommitment?: unknown; }
interface PairingAcceptRequest { token?: unknown; confirmationCode?: unknown; relationshipKeyCommitment?: unknown; }

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

function isPairingConfirmationCode(value: string): boolean {
  const emojis = Array.from(value);
  return emojis.length === 5 && emojis.every((emoji) => (PAIRING_EMOJIS as readonly string[]).includes(emoji));
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
function invitationLifetime(body: InvitationRequest | PairingBootstrapRequest | null): number {
  if (!body) return 0;
  if (body.expiresInSeconds === undefined) return DEFAULT_INVITATION_LIFETIME_MS;
  if (typeof body.expiresInSeconds !== "number" || !Number.isFinite(body.expiresInSeconds)) return 0;
  const seconds = Math.floor(body.expiresInSeconds); if (seconds <= 0) return 0;
  return Math.min(seconds * 1000, MAX_INVITATION_LIFETIME_MS);
}
function equalHex(a: string, b: string): boolean { if (a.length !== b.length) return false; let difference = 0; for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index); return difference === 0; }

async function insertInvitation(env: Env, relationshipId: string, deviceId: string, lifetime: number) {
  const invitationId = randomId(); const token = randomToken(TOKEN_BYTES); const confirmationCode = randomConfirmationCode();
  const tokenHash = await sha256Hex(token); const confirmationCodeHash = await sha256Hex(confirmationCode); const createdAt = Date.now(); const expiresAt = createdAt + lifetime;
  const result = await env.DB.prepare(`INSERT INTO invitations
      (id, relationship_id, token_hash, confirmation_code_hash, created_by_device_id, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 FROM relationships WHERE id = ?2 AND status = 'PAIRING'`)
    .bind(invitationId, relationshipId, tokenHash, confirmationCodeHash, deviceId, createdAt, expiresAt).run();
  if (result.meta.changes !== 1) return null;
  return { invitationId, token, confirmationCode, expiresAt };
}

export async function createInvitation(env: Env, request: Request, device: AuthenticatedDevice): Promise<Response> {
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);
  if (device.participant !== "ME") return errorResponse("PAIRING_CLOSED", "Only the first device can create invitations", 409);
  const body = await readJson<InvitationRequest>(request); const lifetime = invitationLifetime(body); if (lifetime <= 0) return errorResponse("INVALID_REQUEST", "Invalid invitation lifetime", 400);
  const relationship = await env.DB.prepare(`SELECT status, relationship_key_commitment FROM relationships WHERE id = ?1`).bind(device.relationshipId).first<{ status: "PAIRING" | "ACTIVE" | "ENDED"; relationship_key_commitment: string | null }>();
  if (!relationship || relationship.status !== "PAIRING" || !relationship.relationship_key_commitment) return errorResponse("PAIRING_CLOSED", "Relationship is not currently pairable", 409);
  try { const invitation = await insertInvitation(env, device.relationshipId, device.id, lifetime); if (!invitation) return errorResponse("PAIRING_CLOSED", "Relationship is not currently pairable", 409); const relationship = await env.DB.prepare(`SELECT relationship_key_commitment FROM relationships WHERE id = ?1`).bind(device.relationshipId).first<{ relationship_key_commitment: string | null }>(); if (!relationship?.relationship_key_commitment) return errorResponse("PAIRING_CLOSED", "Pairing encryption state is unavailable", 409); return json({ relationshipId: device.relationshipId, relationshipKeyCommitment: relationship.relationship_key_commitment, ...invitation }, 201); }
  catch { return errorResponse("INTERNAL_ERROR", "Invitation could not be created", 500); }
}

export async function acceptInvitation(env: Env, request: Request): Promise<Response> {
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);
  const body = await readJson<PairingAcceptRequest>(request); const token = typeof body?.token === "string" ? body.token : null; const confirmationCode = typeof body?.confirmationCode === "string" ? body.confirmationCode : null; const relationshipKeyCommitment = body?.relationshipKeyCommitment;
  if (!token || !confirmationCode || !isPairingConfirmationCode(confirmationCode) || !isSha256Hex(relationshipKeyCommitment)) return errorResponse("INVALID_REQUEST", "Invalid pairing request", 400);
  const tokenHash = await sha256Hex(token);
  const invitation = await env.DB.prepare(`SELECT id, relationship_id, confirmation_code_hash, expires_at, consumed_at, failed_attempts, locked_until FROM invitations WHERE token_hash = ?1`).bind(tokenHash).first<{ id:string; relationship_id:string; confirmation_code_hash:string; expires_at:number; consumed_at:number|null; failed_attempts:number; locked_until:number|null; }>();
  if (!invitation) return errorResponse("INVALID_INVITATION", "Invalid invitation", 400);
  if (invitation.consumed_at !== null) return errorResponse("INVITATION_CONSUMED", "Invitation has already been consumed", 409);
  const now = Date.now(); if (invitation.expires_at <= now) return errorResponse("INVALID_INVITATION", "Invitation has expired", 400);
  if (invitation.locked_until !== null && invitation.locked_until > now) { const retryAfter = Math.max(1, Math.ceil((invitation.locked_until - now) / 1000)); return new Response(JSON.stringify({ error: { code:"PAIRING_RATE_LIMITED", message:"Too many invalid confirmation attempts" } }), { status:429, headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","retry-after":String(retryAfter)} }); }
  const suppliedCodeHash = await sha256Hex(confirmationCode);
  if (!equalHex(suppliedCodeHash, invitation.confirmation_code_hash)) { const lockUntil = now + CONFIRMATION_LOCKOUT_MS; await env.DB.prepare(`UPDATE invitations SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= ?1 THEN ?2 ELSE locked_until END WHERE id = ?3 AND consumed_at IS NULL AND expires_at > ?4`).bind(MAX_CONFIRMATION_ATTEMPTS, lockUntil, invitation.id, now).run(); return errorResponse("INVALID_INVITATION", "Invalid invitation", 400); }
  const relationship = await env.DB.prepare(`SELECT status, relationship_key_commitment FROM relationships WHERE id = ?1`).bind(invitation.relationship_id).first<{ status: "PAIRING"|"ACTIVE"|"ENDED"; relationship_key_commitment: string | null }>();
  if (!relationship || relationship.status !== "PAIRING" || !relationship.relationship_key_commitment) return errorResponse("PAIRING_CLOSED", "Pairing is no longer open", 409);
  if (!equalHex(relationship.relationship_key_commitment, relationshipKeyCommitment)) return errorResponse("INVALID_INVITATION", "Invalid invitation", 400);
  const activeDevices = await env.DB.prepare(`SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1 AND revoked_at IS NULL`).bind(invitation.relationship_id).first<{count:number}>();
  if (activeDevices?.count !== 1) return errorResponse("PAIRING_CONFLICT", "Pairing state is invalid", 409);
  const activeDevice = await env.DB.prepare(`SELECT id FROM devices WHERE relationship_id = ?1 AND participant = 'ME' AND revoked_at IS NULL`).bind(invitation.relationship_id).first<{id:string}>();
  if (!activeDevice) return errorResponse("PAIRING_CONFLICT", "Pairing state is invalid", 409);
  const deviceId = randomId(); const credential = randomToken(CREDENTIAL_BYTES); const credentialHash = await sha256Hex(credential);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO devices (id, relationship_id, participant, credential_hash, created_at, last_seen_at) SELECT ?1, relationship_id, 'PARTNER', ?2, ?3, ?3 FROM invitations WHERE id = ?4 AND consumed_at IS NULL AND expires_at > ?3 AND (locked_until IS NULL OR locked_until <= ?3) AND EXISTS (SELECT 1 FROM relationships WHERE id = relationship_id AND status = 'PAIRING')`).bind(deviceId, credentialHash, now, invitation.id),
      env.DB.prepare(`UPDATE invitations SET consumed_at = ?1, consumed_by_device_id = ?2 WHERE id = ?3 AND consumed_at IS NULL AND expires_at > ?1 AND (locked_until IS NULL OR locked_until <= ?1)`).bind(now, deviceId, invitation.id),
      env.DB.prepare(`UPDATE relationships SET status = 'ACTIVE' WHERE id = ?1 AND status = 'PAIRING' AND EXISTS (SELECT 1 FROM invitations WHERE id = ?2 AND consumed_by_device_id = ?3)`).bind(invitation.relationship_id, invitation.id, deviceId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) return errorResponse("PAIRING_CONFLICT", "Invitation was already consumed", 409);
  } catch { return errorResponse("PAIRING_CONFLICT", "Pairing could not be completed", 409); }
  return json({ relationshipId:invitation.relationship_id, deviceId, participant:"PARTNER" satisfies Participant, credential, relationshipKeyCommitment: relationship.relationship_key_commitment }, 201);
}

export async function bootstrapPairing(env: Env, request: Request): Promise<Response> {
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);
  const body = await readJson<PairingCreateRequest>(request); const lifetime = invitationLifetime(body); if (lifetime <= 0 || !isSha256Hex(body?.relationshipKeyCommitment)) return errorResponse("INVALID_REQUEST", "Invalid pairing request", 400);
  const relationshipId = randomId(); const deviceId = randomId(); const invitationId = randomId(); const credential = randomToken(CREDENTIAL_BYTES); const token = randomToken(TOKEN_BYTES); const confirmationCode = randomConfirmationCode();
  const credentialHash = await sha256Hex(credential); const tokenHash = await sha256Hex(token); const confirmationCodeHash = await sha256Hex(confirmationCode); const now = Date.now(); const expiresAt = now + lifetime;
  try { await env.DB.batch([
    env.DB.prepare(`INSERT INTO relationships (id, status, next_server_seq, created_at, relationship_key_commitment) VALUES (?1, 'PAIRING', 1, ?2, ?3)`).bind(relationshipId, now, body?.relationshipKeyCommitment),
    env.DB.prepare(`INSERT INTO devices (id, relationship_id, participant, credential_hash, created_at, last_seen_at) VALUES (?1, ?2, 'ME', ?3, ?4, ?4)`).bind(deviceId, relationshipId, credentialHash, now),
    env.DB.prepare(`INSERT INTO invitations (id, relationship_id, token_hash, confirmation_code_hash, created_by_device_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(invitationId, relationshipId, tokenHash, confirmationCodeHash, deviceId, now, expiresAt),
  ]); } catch { return errorResponse("INTERNAL_ERROR", "Pairing could not be initialized", 500); }
  return json({ relationshipId, invitationId, deviceId, participant:"ME" satisfies Participant, credential, token, confirmationCode, relationshipKeyCommitment: body?.relationshipKeyCommitment, expiresAt }, 201);
}
