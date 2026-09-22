import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";

async function json(response: Response): Promise<Record<string, unknown>> { return (await response.json()) as Record<string, unknown>; }
async function bootstrap(): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }) });
  expect(response.status).toBe(201); return json(response);
}

describe("Rucola cloud worker", () => {
  it("reports a healthy migrated database", async () => { const response = await exports.default.fetch("https://rucola.test/health"); expect(response.status).toBe(200); await expect(response.json()).resolves.toMatchObject({ ok: true, database: true, service: "rucola-cloud", version: "sync-hardening-1" }); });
  it("exposes all seven pairing/sync tables after migrations", async () => { const response = await exports.default.fetch("https://rucola.test/health/schema"); expect(response.status).toBe(200); const body = await json(response); expect(body.ok).toBe(true); expect(body.tables).toEqual([{ table: "relationships", present: true }, { table: "devices", present: true }, { table: "invitations", present: true }, { table: "media_uploads", present: true }, { table: "mailbox_messages", present: true }, { table: "message_receipts", present: true }, { table: "pairing_sessions", present: true }]); });
  it("does not authenticate missing credentials", async () => { const response = await exports.default.fetch("https://rucola.test/v1/auth/probe"); expect(response.status).toBe(401); });
  it("authenticates a non-revoked device using only the credential hash", async () => { const token = "c3-test-credential"; const credentialHash = await sha256Hex(token); const now = Date.now(); await env.DB.prepare(`INSERT INTO relationships (id, status, next_server_seq, created_at) VALUES (?1, 'ACTIVE', 1, ?2)`).bind("relationship-test", now).run(); await env.DB.prepare(`INSERT INTO devices (id, relationship_id, participant, credential_hash, created_at, last_seen_at) VALUES (?1, ?2, 'ME', ?3, ?4, ?4)`).bind("device-test", "relationship-test", credentialHash, now).run(); const response = await exports.default.fetch("https://rucola.test/v1/auth/probe", { headers: { authorization: `Bearer ${token}` } }); expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({ authenticated: true, participant: "ME", relationshipStatus: "ACTIVE" }); });
  it("bootstraps a pairing atomically with a first device and invitation", async () => { const body = await bootstrap(); expect(typeof body.relationshipId).toBe("string"); expect(typeof body.deviceId).toBe("string"); expect(typeof body.invitationId).toBe("string"); expect(typeof body.credential).toBe("string"); expect(typeof body.token).toBe("string"); expect(typeof body.confirmationCode).toBe("string"); expect(Array.from(String(body.confirmationCode))).toHaveLength(5); expect(String(body.confirmationCode)).not.toMatch(/\d/); expect(body.relationshipKeyCommitment).toBe("a".repeat(64)); const relationship = await env.DB.prepare(`SELECT status, relationship_key_commitment FROM relationships WHERE id = ?1`).bind(body.relationshipId).first<{ status: string; relationship_key_commitment: string | null }>(); expect(relationship?.status).toBe("PAIRING"); expect(relationship?.relationship_key_commitment).toBe("a".repeat(64)); const device = await env.DB.prepare(`SELECT participant, credential_hash FROM devices WHERE id = ?1`).bind(body.deviceId).first<{ participant: string; credential_hash: string }>(); expect(device?.participant).toBe("ME"); expect(device?.credential_hash).toBe(await sha256Hex(String(body.credential))); expect(device?.credential_hash).not.toBe(body.credential); });
  it("runs the hidden pairing session through lookup, relay, and atomic completion", async () => {
    const body = await bootstrap();
    const sessionId = "BwcHBwcHBwcHBwcHBwcHBQ==";
    const initiatorShare = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const responderShare = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
    const handoff = "rucola-cpace20-v1.AAAA.AAAA.AAAA";
    const confirmation = "rucola-cpace20-v1.AAAA.AAAA.AAAA";
    const partnerCredentialHash = "c".repeat(64);

    const start = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "START",
        sessionId,
        invitationId: body.invitationId,
        share: initiatorShare,
      }),
    });
    expect(start.status).toBe(201);

    const join = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.241" },
      body: JSON.stringify({ action: "JOIN", confirmationCode: body.confirmationCode }),
    });
    expect(join.status).toBe(200);
    const joined = await json(join);
    expect(joined.sessionId).toBe(sessionId);
    expect(joined.initiatorShare).toBe(initiatorShare);
    expect(joined.relationshipId).toBe(body.relationshipId);

    const publishResponder = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.241" },
      body: JSON.stringify({
        action: "PUBLISH_RESPONDER_SHARE",
        sessionId,
        confirmationCode: body.confirmationCode,
        share: responderShare,
      }),
    });
    if (publishResponder.status !== 200) {
      throw new Error(`publish responder failed: ${publishResponder.status} ${await publishResponder.clone().text()}`);
    }

    const publishHandoff = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "PUBLISH_HANDOFF", sessionId, handoff }),
    });
    expect(publishHandoff.status).toBe(200);

    const publishConfirmation = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.241" },
      body: JSON.stringify({
        action: "PUBLISH_CONFIRMATION",
        sessionId,
        confirmationCode: body.confirmationCode,
        confirmation,
        partnerCredentialHash,
      }),
    });
    expect(publishConfirmation.status).toBe(200);

    const beforeComplete = await env.DB.prepare(
      "SELECT consumed_at FROM invitations WHERE id = ?1",
    ).bind(body.invitationId).first<{ consumed_at: number | null }>();
    expect(beforeComplete?.consumed_at).toBeNull();

    const complete = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "COMPLETE", sessionId }),
    });
    expect(complete.status).toBe(200);
    const completed = await json(complete);
    expect(completed.completed).toBe(true);
    expect(typeof completed.partnerDeviceId).toBe("string");

    const relationship = await env.DB.prepare(
      "SELECT status FROM relationships WHERE id = ?1",
    ).bind(body.relationshipId).first<{ status: string }>();
    expect(relationship?.status).toBe("ACTIVE");

    const invitation = await env.DB.prepare(
      "SELECT consumed_at, consumed_by_device_id FROM invitations WHERE id = ?1",
    ).bind(body.invitationId).first<{ consumed_at: number | null; consumed_by_device_id: string | null }>();
    expect(invitation?.consumed_at).not.toBeNull();
    expect(invitation?.consumed_by_device_id).toBe(completed.partnerDeviceId);

    const session = await env.DB.prepare(
      "SELECT completed_at FROM pairing_sessions WHERE id = ?1",
    ).bind(sessionId).first<{ completed_at: number | null }>();
    expect(session?.completed_at).not.toBeNull();

    const replay = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "COMPLETE", sessionId }),
    });
    expect(replay.status).toBe(400);
  });

  it("accepts a valid invitation exactly once", async () => { const body = await bootstrap(); const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) }); expect(response.status).toBe(201); const accepted = await json(response); expect(accepted.relationshipId).toBe(body.relationshipId); expect(accepted.participant).toBe("PARTNER"); const relationship = await env.DB.prepare(`SELECT status FROM relationships WHERE id = ?1`).bind(body.relationshipId).first<{ status: string }>(); expect(relationship?.status).toBe("ACTIVE"); const devices = await env.DB.prepare(`SELECT participant, revoked_at FROM devices WHERE relationship_id = ?1 ORDER BY participant`).bind(body.relationshipId).all<{ participant: string; revoked_at: number | null }>(); expect(devices.results).toHaveLength(2); expect(devices.results.map((device) => device.participant)).toEqual(["ME", "PARTNER"]); expect(devices.results.every((device) => device.revoked_at === null)).toBe(true); const invitation = await env.DB.prepare(`SELECT consumed_at, consumed_by_device_id FROM invitations WHERE id = ?1`).bind(body.invitationId).first<{ consumed_at: number | null; consumed_by_device_id: string | null }>(); expect(invitation?.consumed_at).not.toBeNull(); expect(invitation?.consumed_by_device_id).toBe(accepted.deviceId); const replay = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) }); expect(replay.status).toBe(409); });
  it("rejects an invalid confirmation code without mutating pairing state", async () => { const body = await bootstrap(); const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: "😀😀😀😀😀", relationshipKeyCommitment: "a".repeat(64) }) }); expect(response.status).toBe(400); const devices = await env.DB.prepare(`SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1`).bind(body.relationshipId).first<{ count: number }>(); expect(devices?.count).toBe(1); });
  it("rejects an expired invitation without creating the second device", async () => { const body = await bootstrap(); const now = Date.now(); await env.DB.prepare(`UPDATE invitations SET created_at = ?1, expires_at = ?2 WHERE id = ?3`).bind(now - 1000, now - 1, body.invitationId).run(); const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) }); expect(response.status).toBe(400); const devices = await env.DB.prepare(`SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1`).bind(body.relationshipId).first<{ count: number }>(); expect(devices?.count).toBe(1); });
  it("allows a pairing invitation to be regenerated by the first authenticated device", async () => { const body = await bootstrap(); const response = await exports.default.fetch("https://rucola.test/v1/pairing/create", { method: "POST", headers: { authorization: `Bearer ${body.credential}`, "content-type": "application/json" }, body: JSON.stringify({ expiresInSeconds: 120 }) }); expect(response.status).toBe(201); const replacement = await json(response); expect(replacement.relationshipId).toBe(body.relationshipId); expect(replacement.token).not.toBe(body.token); });
  it("lets only one of many concurrent accepts consume an invitation", async () => { const body = await bootstrap(); const requests = Array.from({ length: 10 }, () => exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) })); const responses = await Promise.all(requests); expect(responses.filter((response) => response.status === 201)).toHaveLength(1); expect(responses.filter((response) => response.status === 409)).toHaveLength(9); const devices = await env.DB.prepare(`SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1`).bind(body.relationshipId).first<{ count: number }>(); expect(devices?.count).toBe(2); });
  it("does not trust a client-supplied relationship or participant", async () => { const body = await bootstrap(); const response = await exports.default.fetch("https://rucola.test/v1/auth/probe", { headers: { authorization: `Bearer ${body.credential}` } }); expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({ authenticated: true, participant: "ME", relationshipStatus: "PAIRING" }); });
  it("routes sync endpoints by their current implementation status", async () => { const push = await exports.default.fetch("https://rucola.test/v1/sync/push", { method: "POST" }); const pull = await exports.default.fetch("https://rucola.test/v1/sync/pull"); const ack = await exports.default.fetch("https://rucola.test/v1/sync/ack", { method: "POST" }); const legacyAck = await exports.default.fetch("https://rucola.test/v1/sync/ack/message-test", { method: "POST" }); expect(push.status).toBe(401); expect(pull.status).toBe(401); expect(ack.status).toBe(401); expect(legacyAck.status).toBe(404); });
});
