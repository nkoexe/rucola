import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let bootstrapTestId = 0;

async function bootstrap(): Promise<Record<string, unknown>> {
  bootstrapTestId += 1;
  const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.51.100.${bootstrapTestId}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

function wrongConfirmationCode(correct: unknown): string {
  return correct === "😀😀😀😀😀" ? "😃😃😃😃😃" : "😀😀😀😀😀";
}

async function relationshipCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM relationships").first<{ count: number }>();
  return row?.count ?? 0;
}



function sessionId(value: number): string {
  return Buffer.alloc(16, value).toString("base64");
}

function cpaceShare(value: number): string {
  return Buffer.alloc(32, value).toString("base64");
}

const TEST_ENVELOPE = "rucola-cpace20-v1.AA==.AA==.AA==";

it("binds the responder device id and keeps it available after completion", async () => {
  const body = await bootstrap();
  const initiatorAuth = { authorization: `Bearer ${String(body.credential)}` };
  const id = sessionId(11);
  const initiatorShare = cpaceShare(12);
  const responderShare = cpaceShare(13);
  const partnerDeviceId = "partner-device-11";
  const partnerCredentialHash = "b".repeat(64);

  const start = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...initiatorAuth },
    body: JSON.stringify({
      action: "START",
      sessionId: id,
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
  expect(joined.sessionId).toBe(id);
  expect(joined.invitationId).toBe(body.invitationId);

  const publishShare = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.242" },
    body: JSON.stringify({
      action: "PUBLISH_RESPONDER_SHARE",
      sessionId: id,
      confirmationCode: body.confirmationCode,
      share: responderShare,
    }),
  });
  expect(publishShare.status).toBe(200);

  const handoff = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...initiatorAuth },
    body: JSON.stringify({ action: "PUBLISH_HANDOFF", sessionId: id, handoff: TEST_ENVELOPE }),
  });
  expect(handoff.status).toBe(200);

  const confirmation = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.243" },
    body: JSON.stringify({
      action: "PUBLISH_CONFIRMATION",
      sessionId: id,
      confirmationCode: body.confirmationCode,
      confirmation: TEST_ENVELOPE,
      partnerCredentialHash,
      partnerDeviceId,
    }),
  });
  expect(confirmation.status).toBe(200);

  const duplicateConfirmation = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.244" },
    body: JSON.stringify({
      action: "PUBLISH_CONFIRMATION",
      sessionId: id,
      confirmationCode: body.confirmationCode,
      confirmation: TEST_ENVELOPE,
      partnerCredentialHash,
      partnerDeviceId,
    }),
  });
  expect(duplicateConfirmation.status).toBe(200);

  const stored = await env.DB.prepare(
    "SELECT partner_device_id, partner_credential_hash FROM pairing_sessions WHERE id = ?1",
  ).bind(id).first<{ partner_device_id: string | null; partner_credential_hash: string | null }>();
  expect(stored?.partner_device_id).toBe(partnerDeviceId);
  expect(stored?.partner_credential_hash).toBe(partnerCredentialHash);

  const complete = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...initiatorAuth },
    body: JSON.stringify({ action: "COMPLETE", sessionId: id }),
  });
  expect(complete.status).toBe(200);
  expect((await json(complete)).partnerDeviceId).toBe(partnerDeviceId);

  const device = await env.DB.prepare(
    "SELECT id, participant FROM devices WHERE id = ?1 AND relationship_id = ?2 AND revoked_at IS NULL",
  ).bind(partnerDeviceId, body.relationshipId).first<{ id: string; participant: string }>();
  expect(device).toEqual({ id: partnerDeviceId, participant: "PARTNER" });

  const responderPoll = await exports.default.fetch("https://rucola.test/v1/pairing/session", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.245" },
    body: JSON.stringify({ action: "POLL", sessionId: id, confirmationCode: body.confirmationCode }),
  });
  expect(responderPoll.status).toBe(200);
  const polled = await json(responderPoll);
  expect(polled.confirmation).toBe(TEST_ENVELOPE);
  expect(polled.partnerDeviceId).toBe(partnerDeviceId);
});

describe("Rucola pairing hardening", () => {
  it("rejects oversized JSON bodies before parsing", async () => {
    const before = await relationshipCount();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${++bootstrapTestId}` }, body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64), padding: "x".repeat(20_000) }) });
    expect(response.status).toBe(400); expect(await relationshipCount()).toBe(before);
  });

  it("rejects empty, null, array, and malformed JSON bodies", async () => {
    const before = await relationshipCount();
    for (const body of ["", "null", "[]", "{"]) {
      const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${++bootstrapTestId}` }, body });
      expect(response.status).toBe(400);
    }
    expect(await relationshipCount()).toBe(before);
  });

  it("requires the exact JSON media type while accepting parameters", async () => {
    const valid = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", "cf-connecting-ip": `198.51.100.${++bootstrapTestId}` }, body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }) });
    expect(valid.status).toBe(201);
    const invalid = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "POST", headers: { "content-type": "application/json-malicious", "cf-connecting-ip": `198.51.100.${++bootstrapTestId}` }, body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }) });
    expect(invalid.status).toBe(400);
  });

  it("rejects unsupported methods on known routes", async () => {
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "GET" });
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("locks an invitation after repeated invalid confirmation codes", async () => {
    const body = await bootstrap(); const invalidCode = wrongConfirmationCode(body.confirmationCode);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: invalidCode, relationshipKeyCommitment: "a".repeat(64) }) });
      expect(response.status).toBe(400);
    }
    const invitation = await env.DB.prepare("SELECT failed_attempts, locked_until FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ failed_attempts: number; locked_until: number | null }>();
    expect(invitation?.failed_attempts).toBe(5); expect(invitation?.locked_until).not.toBeNull(); expect(invitation?.locked_until).toBeGreaterThan(Date.now());
    const blocked = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) });
    expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    await env.DB.prepare("UPDATE invitations SET locked_until = ?1 WHERE id = ?2").bind(Date.now() - 1, body.invitationId).run();
    const accepted = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) });
    expect(accepted.status).toBe(201);
  });

  it("does not mutate pairing state for another invalid confirmation code", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: wrongConfirmationCode(body.confirmationCode), relationshipKeyCommitment: "a".repeat(64) }) });
    expect(response.status).toBe(400);
    const invitation = await env.DB.prepare("SELECT consumed_at, failed_attempts FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ consumed_at: number | null; failed_attempts: number }>();
    expect(invitation?.consumed_at).toBeNull(); expect(invitation?.failed_attempts).toBe(1);
  });

  it("rejects concurrent acceptance of the same invitation", async () => {
    const body = await bootstrap();
    const request = () => exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const devices = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1 AND revoked_at IS NULL").bind(body.relationshipId).first<{ count: number }>();
    const relationship = await env.DB.prepare("SELECT status FROM relationships WHERE id = ?1").bind(body.relationshipId).first<{ status: string }>();
    const invitation = await env.DB.prepare("SELECT consumed_at FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ consumed_at: number | null }>();
    expect(devices?.count).toBe(2); expect(relationship?.status).toBe("ACTIVE"); expect(invitation?.consumed_at).not.toBeNull();
  });

  it("uses exactly five emojis for human confirmation", async () => {
    const body = await bootstrap();
    expect(Array.from(String(body.confirmationCode))).toHaveLength(5);
    expect(String(body.confirmationCode)).not.toMatch(/\d/);
  });

  it("rejects a pairing key commitment mismatch without consuming the invitation", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: body.token,
        confirmationCode: body.confirmationCode,
        relationshipKeyCommitment: "b".repeat(64),
      }),
    });
    expect(response.status).toBe(400);
    const invitation = await env.DB.prepare("SELECT consumed_at FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ consumed_at: number | null }>();
    expect(invitation?.consumed_at).toBeNull();
    const devices = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1 AND revoked_at IS NULL").bind(body.relationshipId).first<{ count: number }>();
    expect(devices?.count).toBe(1);
  });

  it("rejects an invalid confirmation shape before mutating the invitation", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: body.token,
        confirmationCode: "12345",
        relationshipKeyCommitment: "a".repeat(64),
      }),
    });
    expect(response.status).toBe(400);
    const invitation = await env.DB.prepare("SELECT consumed_at, failed_attempts FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ consumed_at: number | null; failed_attempts: number }>();
    expect(invitation?.consumed_at).toBeNull();
    expect(invitation?.failed_attempts).toBe(0);
  });

  it("rejects invitation creation from a non-ME device", async () => {
    const body = await bootstrap();
    const accepted = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }) });
    expect(accepted.status).toBe(201);
    const acceptedBody = await json(accepted);
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/create", { method: "POST", headers: { authorization: `Bearer ${acceptedBody.credential}`, "content-type": "application/json" }, body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }) });
    expect(response.status).toBe(409);
  });

  it("sets defensive response headers on API responses", async () => {
    const response = await exports.default.fetch("https://rucola.test/health");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
