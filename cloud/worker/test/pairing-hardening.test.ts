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
      const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: invalidCode }) });
      expect(response.status).toBe(400);
    }
    const invitation = await env.DB.prepare("SELECT failed_attempts, locked_until FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ failed_attempts: number; locked_until: number | null }>();
    expect(invitation?.failed_attempts).toBe(5); expect(invitation?.locked_until).not.toBeNull(); expect(invitation?.locked_until).toBeGreaterThan(Date.now());
    const blocked = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }) });
    expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    await env.DB.prepare("UPDATE invitations SET locked_until = ?1 WHERE id = ?2").bind(Date.now() - 1, body.invitationId).run();
    const accepted = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }) });
    expect(accepted.status).toBe(201);
  });

  it("does not mutate pairing state for another invalid confirmation code", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: wrongConfirmationCode(body.confirmationCode) }) });
    expect(response.status).toBe(400);
    const invitation = await env.DB.prepare("SELECT consumed_at, failed_attempts FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ consumed_at: number | null; failed_attempts: number }>();
    expect(invitation?.consumed_at).toBeNull(); expect(invitation?.failed_attempts).toBe(1);
  });

  it("rejects concurrent acceptance of the same invitation", async () => {
    const body = await bootstrap();
    const request = () => exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }) });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const devices = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1 AND revoked_at IS NULL").bind(body.relationshipId).first<{ count: number }>();
    const relationship = await env.DB.prepare("SELECT status FROM relationships WHERE id = ?1").bind(body.relationshipId).first<{ status: string }>();
    const invitation = await env.DB.prepare("SELECT consumed_at FROM invitations WHERE id = ?1").bind(body.invitationId).first<{ consumed_at: number | null }>();
    expect(devices?.count).toBe(2); expect(relationship?.status).toBe("ACTIVE"); expect(invitation?.consumed_at).not.toBeNull();
  });

  it("rejects invitation creation from a non-ME device", async () => {
    const body = await bootstrap();
    const accepted = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }) });
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
