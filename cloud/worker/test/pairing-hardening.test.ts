import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function bootstrap(): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

describe("Rucola pairing hardening", () => {
  it("rejects oversized JSON bodies before parsing", async () => {
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresInSeconds: 3600, padding: "x".repeat(20_000) }),
    });

    expect(response.status).toBe(400);

    const relationships = await env.DB.prepare("SELECT COUNT(*) AS count FROM relationships")
      .first<{ count: number }>();
    expect(relationships?.count).toBe(0);
  });

  it("locks an invitation after repeated invalid confirmation codes", async () => {
    const body = await bootstrap();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token, confirmationCode: "000000" }),
      });
      expect(response.status).toBe(400);
    }

    const invitation = await env.DB.prepare(
      "SELECT failed_attempts, locked_until FROM invitations WHERE id = ?1",
    )
      .bind(body.invitationId)
      .first<{ failed_attempts: number; locked_until: number | null }>();

    expect(invitation?.failed_attempts).toBe(5);
    expect(invitation?.locked_until).not.toBeNull();
    expect(invitation?.locked_until).toBeGreaterThan(Date.now());

    const blocked = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);

    await env.DB.prepare("UPDATE invitations SET locked_until = ?1 WHERE id = ?2")
      .bind(Date.now() - 1, body.invitationId)
      .run();

    const accepted = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }),
    });
    expect(accepted.status).toBe(201);
  });

  it("does not mutate pairing state for another invalid confirmation code", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: "123456" }),
    });
    expect(response.status).toBe(400);

    const invitation = await env.DB.prepare(
      "SELECT consumed_at, failed_attempts FROM invitations WHERE id = ?1",
    )
      .bind(body.invitationId)
      .first<{ consumed_at: number | null; failed_attempts: number }>();
    expect(invitation?.consumed_at).toBeNull();
    expect(invitation?.failed_attempts).toBe(1);
  });

  it("sets defensive response headers on API responses", async () => {
    const response = await exports.default.fetch("https://rucola.test/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
