import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Rucola cloud worker", () => {
  it("reports a healthy migrated database", async () => {
    const response = await exports.default.fetch("https://rucola.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      database: true,
      service: "rucola-cloud",
      version: "c3",
    });
  });

  it("exposes all five C2 tables after migrations", async () => {
    const response = await exports.default.fetch("https://rucola.test/health/schema");
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.ok).toBe(true);
    expect(body.tables).toEqual([
      { table: "relationships", present: true },
      { table: "devices", present: true },
      { table: "invitations", present: true },
      { table: "media_uploads", present: true },
      { table: "mailbox_messages", present: true },
    ]);
  });

  it("does not authenticate missing credentials", async () => {
    const response = await exports.default.fetch("https://rucola.test/v1/auth/probe");
    expect(response.status).toBe(401);
  });

  it("authenticates a non-revoked device using only the credential hash", async () => {
    const token = "c3-test-credential";
    const credentialHash = await sha256Hex(token);

    await env.DB.prepare(
      `INSERT INTO relationships (id, status, next_server_seq, created_at)
       VALUES (?1, 'ACTIVE', 1, ?2)`,
    )
      .bind("relationship-test", Date.now())
      .run();

    await env.DB.prepare(
      `INSERT INTO devices
       (id, relationship_id, participant, credential_hash, created_at, last_seen_at)
       VALUES (?1, ?2, 'ME', ?3, ?4, ?4)`,
    )
      .bind("device-test", "relationship-test", credentialHash, Date.now())
      .run();

    const response = await exports.default.fetch("https://rucola.test/v1/auth/probe", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      participant: "ME",
    });
  });
});
