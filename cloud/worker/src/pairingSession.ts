import { authenticateDevice, sha256Hex } from "./auth";
import { errorResponse, json } from "./http";
import type { AuthenticatedDevice, Env } from "./types";

const MAX_BODY_BYTES = 16 * 1024;
const SESSION_ID_BYTES = 16;
const CPACE_SHARE_BYTES = 32;
const HANDOFF_MAX_LENGTH = 2048;
const CONFIRMATION_MAX_LENGTH = 1024;
const SESSION_LIFETIME_MS = 15 * 60 * 1000;
const CREDENTIAL_HASH_RE = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9+/]{22}==$/;
const CPACE_SHARE_RE = /^[A-Za-z0-9+/]{43}=$/;
const ENVELOPE_RE = /^rucola-cpace20-v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;

const PAIRING_EMOJIS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
  "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰",
  "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪",
  "😎", "🤩", "🥳", "🤗", "🤔", "🥺", "😭", "😡",
  "😴",
] as const;

type SessionAction =
  | "START"
  | "JOIN"
  | "PUBLISH_RESPONDER_SHARE"
  | "PUBLISH_HANDOFF"
  | "PUBLISH_CONFIRMATION"
  | "COMPLETE"
  | "POLL";

interface SessionRequest {
  action?: unknown;
  sessionId?: unknown;
  invitationId?: unknown;
  confirmationCode?: unknown;
  share?: unknown;
  handoff?: unknown;
  confirmation?: unknown;
  partnerCredentialHash?: unknown;
}

interface SessionRow {
  id: string;
  invitation_id: string;
  relationship_id: string;
  expires_at: number;
  initiator_share: string;
  responder_share: string | null;
  handoff: string | null;
  confirmation: string | null;
  partner_credential_hash: string | null;
  completed_at: number | null;
  created_at: number;
}

function isJsonContentType(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readJson(request: Request): Promise<SessionRequest | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES) return null;
  }
  if (!request.body) return null;

  try {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) return null;
    const value = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as SessionRequest;
  } catch {
    return null;
  }
}

function actionOf(value: unknown): SessionAction | null {
  return value === "START" ||
    value === "JOIN" ||
    value === "PUBLISH_RESPONDER_SHARE" ||
    value === "PUBLISH_HANDOFF" ||
    value === "PUBLISH_CONFIRMATION" ||
    value === "COMPLETE" ||
    value === "POLL"
    ? value
    : null;
}

function isBase64Bytes(value: unknown, expectedBytes: number, pattern: RegExp): value is string {
  if (typeof value !== "string" || !pattern.test(value)) return false;
  try {
    return atob(value).length === expectedBytes;
  } catch {
    return false;
  }
}

function isSessionId(value: unknown): value is string {
  return isBase64Bytes(value, SESSION_ID_BYTES, SESSION_ID_RE);
}

function isCpaceShare(value: unknown): value is string {
  return isBase64Bytes(value, CPACE_SHARE_BYTES, CPACE_SHARE_RE);
}

function isEnvelope(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    ENVELOPE_RE.test(value);
}

function isPairingCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const emojis = Array.from(value);
  return emojis.length === 5 &&
    emojis.every((emoji) => (PAIRING_EMOJIS as readonly string[]).includes(emoji));
}

function invalidSession(): Response {
  return errorResponse("INVALID_PAIRING_SESSION", "Pairing session is invalid", 400);
}

async function getSession(env: Env, sessionId: string): Promise<SessionRow | null> {
  return env.DB.prepare(
    "SELECT id, invitation_id, relationship_id, expires_at, initiator_share, responder_share, handoff, confirmation, partner_credential_hash, completed_at, created_at " +
    "FROM pairing_sessions WHERE id = ?1",
  ).bind(sessionId).first<SessionRow>();
}

async function getInvitationByCode(env: Env, confirmationCode: string) {
  const confirmationHash = await sha256Hex(confirmationCode);
  return env.DB.prepare(
    "SELECT i.id, i.relationship_id, i.expires_at, i.consumed_at, " +
    "r.status, r.relationship_key_commitment " +
    "FROM invitations i JOIN relationships r ON r.id = i.relationship_id " +
    "WHERE i.confirmation_code_hash = ?1 LIMIT 1",
  ).bind(confirmationHash).first<{
    id: string;
    relationship_id: string;
    expires_at: number;
    consumed_at: number | null;
    status: "PAIRING" | "ACTIVE" | "ENDED";
    relationship_key_commitment: string | null;
  }>();
}

async function startSession(
  env: Env,
  body: SessionRequest,
  device: AuthenticatedDevice,
): Promise<Response> {
  if (device.participant !== "ME") {
    return errorResponse("PAIRING_CLOSED", "Only the first device can start pairing sessions", 409);
  }
  if (!isSessionId(body.sessionId) || typeof body.invitationId !== "string" || !isCpaceShare(body.share)) {
    return errorResponse("INVALID_REQUEST", "Invalid pairing session request", 400);
  }

  const invitation = await env.DB.prepare(
    "SELECT id, relationship_id, expires_at, consumed_at FROM invitations " +
    "WHERE id = ?1 AND created_by_device_id = ?2",
  ).bind(body.invitationId, device.id).first<{
    id: string;
    relationship_id: string;
    expires_at: number;
    consumed_at: number | null;
  }>();

  if (!invitation || invitation.relationship_id !== device.relationshipId) {
    return errorResponse("INVALID_INVITATION", "Invitation is no longer available", 409);
  }
  if (invitation.consumed_at !== null) {
    return errorResponse("INVITATION_CONSUMED", "Invitation has already been consumed", 409);
  }
  if (invitation.expires_at <= Date.now()) {
    return errorResponse("INVALID_INVITATION", "Invitation has expired", 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id, expires_at, initiator_share FROM pairing_sessions WHERE invitation_id = ?1",
  ).bind(invitation.id).first<{ id: string; expires_at: number; initiator_share: string }>();

  if (existing) {
    if (existing.expires_at <= Date.now()) {
      return errorResponse("PAIRING_SESSION_EXPIRED", "Pairing session has expired", 409);
    }
    if (existing.id !== body.sessionId || existing.initiator_share !== body.share) {
      return errorResponse("PAIRING_CONFLICT", "Pairing session already started", 409);
    }
    const relationship = await env.DB.prepare(
      "SELECT relationship_key_commitment FROM relationships WHERE id = ?1",
    ).bind(device.relationshipId).first<{ relationship_key_commitment: string | null }>();
    if (!relationship?.relationship_key_commitment) {
      return errorResponse("PAIRING_CLOSED", "Pairing encryption state is unavailable", 409);
    }
    return json({
      sessionId: existing.id,
      expiresAt: existing.expires_at,
      relationshipKeyCommitment: relationship.relationship_key_commitment,
    });
  }

  const relationship = await env.DB.prepare(
    "SELECT relationship_key_commitment, status FROM relationships WHERE id = ?1",
  ).bind(device.relationshipId).first<{ relationship_key_commitment: string | null; status: "PAIRING" | "ACTIVE" | "ENDED" }>();

  if (!relationship || relationship.status !== "PAIRING" || !relationship.relationship_key_commitment) {
    return errorResponse("PAIRING_CLOSED", "Relationship is not currently pairable", 409);
  }

  const now = Date.now();
  const expiresAt = Math.min(invitation.expires_at, now + SESSION_LIFETIME_MS);

  try {
    await env.DB.prepare(
      "INSERT INTO pairing_sessions " +
      "(id, invitation_id, relationship_id, expires_at, initiator_share, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(
      body.sessionId,
      invitation.id,
      invitation.relationship_id,
      expiresAt,
      body.share,
      now,
    ).run();
  } catch {
    return errorResponse("PAIRING_CONFLICT", "Pairing session could not be started", 409);
  }

  return json({
    sessionId: body.sessionId,
    expiresAt,
    relationshipKeyCommitment: relationship.relationship_key_commitment,
  }, 201);
}

async function joinSession(env: Env, body: SessionRequest): Promise<Response> {
  if (!isPairingCode(body.confirmationCode)) {
    return errorResponse("INVALID_REQUEST", "Invalid pairing session request", 400);
  }

  const invitation = await getInvitationByCode(env, body.confirmationCode);
  if (
    !invitation ||
    invitation.status !== "PAIRING" ||
    invitation.consumed_at !== null ||
    invitation.expires_at <= Date.now() ||
    !invitation.relationship_key_commitment
  ) {
    return invalidSession();
  }

  const session = await env.DB.prepare(
    "SELECT id, expires_at, initiator_share FROM pairing_sessions WHERE invitation_id = ?1",
  ).bind(invitation.id).first<{ id: string; expires_at: number; initiator_share: string }>();

  if (!session || session.expires_at <= Date.now()) return invalidSession();

  return json({
    sessionId: session.id,
    expiresAt: session.expires_at,
    initiatorShare: session.initiator_share,
    relationshipId: invitation.relationship_id,
    relationshipKeyCommitment: invitation.relationship_key_commitment,
  });
}

async function publishResponderShare(env: Env, body: SessionRequest): Promise<Response> {
  if (!isSessionId(body.sessionId) || !isPairingCode(body.confirmationCode) || !isCpaceShare(body.share)) {
    return errorResponse("INVALID_REQUEST", "Invalid pairing session payload", 400);
  }

  const invitation = await getInvitationByCode(env, body.confirmationCode);
  if (
    !invitation ||
    invitation.status !== "PAIRING" ||
    invitation.consumed_at !== null ||
    invitation.expires_at <= Date.now()
  ) {
    return invalidSession();
  }

  const session = await getSession(env, body.sessionId);
  if (
    !session ||
    session.invitation_id !== invitation.id ||
    session.relationship_id !== invitation.relationship_id ||
    session.expires_at <= Date.now() ||
    session.completed_at !== null
  ) {
    return invalidSession();
  }

  if (session.responder_share !== null) {
    if (session.responder_share !== body.share) {
      return errorResponse("PAIRING_CONFLICT", "Pairing session is already joined", 409);
    }
    return json({ ok: true });
  }

  const result = await env.DB.prepare(
    "UPDATE pairing_sessions SET responder_share = ?1 " +
    "WHERE id = ?2 AND responder_share IS NULL AND expires_at > ?3",
  ).bind(body.share, session.id, Date.now()).run();

  if ((result.meta.changes ?? 0) !== 1) {
    const current = await getSession(env, session.id);
    if (!current || current.responder_share !== body.share) {
      return errorResponse("PAIRING_CONFLICT", "Pairing session is already joined", 409);
    }
  }

  return json({ ok: true });
}

async function publishHandoff(
  env: Env,
  body: SessionRequest,
  device: AuthenticatedDevice,
): Promise<Response> {
  if (device.participant !== "ME" || !isSessionId(body.sessionId) || !isEnvelope(body.handoff, HANDOFF_MAX_LENGTH)) {
    return invalidSession();
  }

  const session = await getSession(env, body.sessionId);
  if (
    !session ||
    session.relationship_id !== device.relationshipId ||
    session.expires_at <= Date.now() ||
    session.responder_share === null ||
    session.completed_at !== null
  ) {
    return invalidSession();
  }

  const result = await env.DB.prepare(
    "UPDATE pairing_sessions SET handoff = ?1 " +
    "WHERE id = ?2 AND handoff IS NULL AND expires_at > ?3",
  ).bind(body.handoff, session.id, Date.now()).run();

  if ((result.meta.changes ?? 0) !== 1) {
    return errorResponse("PAIRING_CONFLICT", "Pairing handoff already submitted", 409);
  }
  return json({ ok: true });
}

async function publishConfirmation(env: Env, body: SessionRequest): Promise<Response> {
  if (
    !isSessionId(body.sessionId) ||
    !isPairingCode(body.confirmationCode) ||
    !isEnvelope(body.confirmation, CONFIRMATION_MAX_LENGTH) ||
    typeof body.partnerCredentialHash !== "string" ||
    !CREDENTIAL_HASH_RE.test(body.partnerCredentialHash)
  ) {
    return errorResponse("INVALID_REQUEST", "Invalid pairing session payload", 400);
  }

  const invitation = await getInvitationByCode(env, body.confirmationCode);
  if (
    !invitation ||
    invitation.status !== "PAIRING" ||
    invitation.consumed_at !== null ||
    invitation.expires_at <= Date.now() ||
    !invitation.relationship_key_commitment
  ) {
    return invalidSession();
  }

  const session = await getSession(env, body.sessionId);
  if (
    !session ||
    session.invitation_id !== invitation.id ||
    session.relationship_id !== invitation.relationship_id ||
    session.expires_at <= Date.now() ||
    session.responder_share === null ||
    session.handoff === null ||
    session.completed_at !== null
  ) {
    return errorResponse("PAIRING_NOT_READY", "Pairing session is not ready", 409);
  }

  const result = await env.DB.prepare(
    "UPDATE pairing_sessions SET confirmation = ?1, partner_credential_hash = ?2 " +
    "WHERE id = ?3 AND confirmation IS NULL AND partner_credential_hash IS NULL AND expires_at > ?4",
  ).bind(
    body.confirmation,
    body.partnerCredentialHash,
    session.id,
    Date.now(),
  ).run();

  if ((result.meta.changes ?? 0) !== 1) {
    return errorResponse("PAIRING_CONFLICT", "Pairing confirmation already submitted", 409);
  }
  return json({ ok: true });
}

async function completeSession(
  env: Env,
  body: SessionRequest,
  device: AuthenticatedDevice,
): Promise<Response> {
  if (device.participant !== "ME" || !isSessionId(body.sessionId)) return invalidSession();

  const session = await getSession(env, body.sessionId);
  if (
    !session ||
    session.relationship_id !== device.relationshipId ||
    session.expires_at <= Date.now() ||
    session.completed_at !== null ||
    session.responder_share === null ||
    session.handoff === null ||
    session.confirmation === null ||
    session.partner_credential_hash === null
  ) {
    return errorResponse("PAIRING_NOT_READY", "Pairing session is not ready", 409);
  }

  const partnerDeviceId = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO devices " +
    "(id, relationship_id, participant, credential_hash, created_at, last_seen_at) " +
    "SELECT ?1, ?2, 'PARTNER', ?3, ?4, ?4 " +
    "FROM pairing_sessions ps " +
    "JOIN invitations i ON i.id = ps.invitation_id " +
    "JOIN relationships r ON r.id = ps.relationship_id " +
    "WHERE ps.id = ?5 " +
    "AND ps.relationship_id = ?6 " +
    "AND ps.expires_at > ?4 " +
    "AND ps.completed_at IS NULL " +
    "AND ps.responder_share IS NOT NULL " +
    "AND ps.handoff IS NOT NULL " +
    "AND ps.confirmation IS NOT NULL " +
    "AND ps.partner_credential_hash IS NOT NULL " +
    "AND i.consumed_at IS NULL " +
    "AND i.expires_at > ?4 " +
    "AND r.status = 'PAIRING' " +
    "AND EXISTS (" +
    "  SELECT 1 FROM devices d " +
    "  WHERE d.id = ?7 AND d.relationship_id = ?6 " +
    "    AND d.participant = 'ME' AND d.revoked_at IS NULL" +
    ") " +
    "AND NOT EXISTS (" +
    "  SELECT 1 FROM devices d2 " +
    "  WHERE d2.relationship_id = ?6 AND d2.participant = 'PARTNER' AND d2.revoked_at IS NULL" +
    ")",
  ).bind(
    partnerDeviceId,
    session.relationship_id,
    session.partner_credential_hash,
    now,
    session.id,
    device.relationshipId,
    device.id,
  ).run();

  if ((result.meta.changes ?? 0) !== 1) {
    return errorResponse("PAIRING_CONFLICT", "Pairing session could not be completed", 409);
  }

  return json({
    completed: true,
    relationshipId: session.relationship_id,
    partnerDeviceId,
  });
}

async function pollSession(
  env: Env,
  body: SessionRequest,
  device: AuthenticatedDevice | null,
): Promise<Response> {
  if (!isSessionId(body.sessionId)) return invalidSession();

  const session = await getSession(env, body.sessionId);
  if (!session || session.expires_at <= Date.now()) return invalidSession();

  if (device) {
    if (device.participant !== "ME" || device.relationshipId !== session.relationship_id) {
      return invalidSession();
    }
    const relationship = await env.DB.prepare(
      "SELECT relationship_key_commitment FROM relationships WHERE id = ?1",
    ).bind(session.relationship_id).first<{ relationship_key_commitment: string | null }>();

    return json({
      sessionId: session.id,
      expiresAt: session.expires_at,
      initiatorShare: session.initiator_share,
      responderShare: session.responder_share,
      handoff: session.handoff,
      confirmation: session.confirmation,
      partnerCredentialHash: session.partner_credential_hash,
      completed: session.completed_at !== null,
      relationshipKeyCommitment: relationship?.relationship_key_commitment ?? null,
      partnerDeviceId: session.completed_at === null
        ? null
        : (await env.DB.prepare(
            "SELECT id FROM devices WHERE relationship_id = ?1 AND participant = 'PARTNER' AND revoked_at IS NULL LIMIT 1",
          ).bind(session.relationship_id).first<{ id: string }>())?.id ?? null,
    });
  }

  if (!isPairingCode(body.confirmationCode)) return invalidSession();
  const invitation = await getInvitationByCode(env, body.confirmationCode);
  if (
    !invitation ||
    invitation.id !== session.invitation_id ||
    invitation.consumed_at !== null ||
    invitation.expires_at <= Date.now()
  ) {
    return invalidSession();
  }

  return json({
    sessionId: session.id,
    expiresAt: session.expires_at,
    initiatorShare: session.initiator_share,
    responderShare: session.responder_share,
    handoff: session.handoff,
    completed: session.completed_at !== null,
    relationshipKeyCommitment: invitation.relationship_key_commitment,
    partnerDeviceId: session.completed_at === null
      ? null
      : (await env.DB.prepare(
          "SELECT id FROM devices WHERE relationship_id = ?1 AND participant = 'PARTNER' AND revoked_at IS NULL LIMIT 1",
        ).bind(session.relationship_id).first<{ id: string }>())?.id ?? null,
  });
}

export async function handlePairingSession(env: Env, request: Request): Promise<Response> {
  if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  if (!isJsonContentType(request)) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);

  const body = await readJson(request);
  if (!body) return errorResponse("INVALID_REQUEST", "Invalid pairing session request", 400);

  const action = actionOf(body.action);
  if (!action) return errorResponse("INVALID_REQUEST", "Invalid pairing session action", 400);

  const authenticated = await authenticateDevice(env, request);

  if ((action === "START" || action === "PUBLISH_HANDOFF" || action === "COMPLETE") && !authenticated) {
    return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  }

  if (action === "JOIN" || action === "PUBLISH_RESPONDER_SHARE" || action === "PUBLISH_CONFIRMATION" || action === "POLL") {
    const limiterKey = "pairing-session:" + (request.headers.get("cf-connecting-ip") ?? "local-development");
    if (!(await env.PAIRING_BOOTSTRAP_LIMITER.limit({ key: limiterKey })).success) {
      const response = errorResponse("PAIRING_RATE_LIMITED", "Too many pairing attempts", 429);
      response.headers.set("retry-after", "60");
      return response;
    }
  }

  switch (action) {
    case "START":
      return startSession(env, body, authenticated as AuthenticatedDevice);
    case "JOIN":
      return joinSession(env, body);
    case "PUBLISH_RESPONDER_SHARE":
      return publishResponderShare(env, body);
    case "PUBLISH_HANDOFF":
      return publishHandoff(env, body, authenticated as AuthenticatedDevice);
    case "PUBLISH_CONFIRMATION":
      return publishConfirmation(env, body);
    case "COMPLETE":
      return completeSession(env, body, authenticated as AuthenticatedDevice);
    case "POLL":
      return pollSession(env, body, authenticated);
  }
}
