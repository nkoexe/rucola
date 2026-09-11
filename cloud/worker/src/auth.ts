import type { AuthenticatedDevice, Env, Participant } from "./types";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1] ?? null;
}

export async function authenticateDevice(
  env: Env,
  request: Request,
): Promise<AuthenticatedDevice | null> {
  const token = bearerToken(request);
  if (!token) return null;

  const credentialHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id, relationship_id, participant
     FROM devices
     WHERE credential_hash = ?1 AND revoked_at IS NULL`,
  )
    .bind(credentialHash)
    .first<{ id: string; relationship_id: string; participant: Participant }>();

  if (!row) return null;

  return {
    id: row.id,
    relationshipId: row.relationship_id,
    participant: row.participant,
  };
}
