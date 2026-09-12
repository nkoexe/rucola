import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";

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

describe("Rucola cloud worker", () => {
  it("reports a healthy migrated database", async () => {
    const response = await exports.default.fetch("https://rucola.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      database: true,
      service: "rucola-cloud",
      version: "sync-pull-1",
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
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO relationships (id, status, next_server_seq, created_at)
       VALUES (?1, 'ACTIVE', 1, ?2)`,
    )
      .bind("relationship-test", now)
      .run();

    await env.DB.prepare(
      `INSERT INTO devices
       (id, relationship_id, participant, credential_hash, created_at, last_seen_at)
       VALUES (?1, ?2, 'ME', ?3, ?4, ?4)`,
    )
      .bind("device-test", "relationship-test", credentialHash, now)
      .run();

    const response = await exports.default.fetch("https://rucola.test/v1/auth/probe", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true, participant: "ME" });
  });

  it("bootstraps a pairing atomically with a first device and invitation", async () => {
    const body = await bootstrap();
    expect(typeof body.relationshipId).toBe("string");
    expect(typeof body.deviceId).toBe("string");
    expect(typeof body.invitationId).toBe("string");
    expect(typeof body.credential).toBe("string");
    expect(typeof body.token).toBe("string");
    expect(typeof body.confirmationCode).toBe("string");

    const relationship = await env.DB.prepare(
      `SELECT status FROM relationships WHERE id = ?1`,
    )
      .bind(body.relationshipId)
      .first<{ status: string }>();
    expect(relationship?.status).toBe("PAIRING");

    const device = await env.DB.prepare(
      `SELECT participant, credential_hash FROM devices WHERE id = ?1`,
    )
      .bind(body.deviceId)
      .first<{ participant: string; credential_hash: string }>();
    expect(device?.participant).toBe("ME");
    expect(device?.credential_hash).toBe(await sha256Hex(String(body.credential)));
    expect(device?.credential_hash).not.toBe(body.credential);
  });

  it("accepts a valid invitation exactly once", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }),
    });

    expect(response.status).toBe(201);
    const accepted = await json(response);
    expect(accepted.relationshipId).toBe(body.relationshipId);
    expect(accepted.participant).toBe("PARTNER");
    expect(typeof accepted.deviceId).toBe("string");
    expect(typeof accepted.credential).toBe("string");

    const relationship = await env.DB.prepare(
      `SELECT status FROM relationships WHERE id = ?1`,
    )
      .bind(body.relationshipId)
      .first<{ status: string }>();
    expect(relationship?.status).toBe("ACTIVE");

    const devices = await env.DB.prepare(
      `SELECT participant, revoked_at FROM devices WHERE relationship_id = ?1 ORDER BY participant`,
    )
      .bind(body.relationshipId)
      .all<{ participant: string; revoked_at: number | null }>();
    expect(devices.results).toHaveLength(2);
    expect(devices.results.map((device) => device.participant)).toEqual(["ME", "PARTNER"]);
    expect(devices.results.every((device) => device.revoked_at === null)).toBe(true);

    const invitation = await env.DB.prepare(
      `SELECT consumed_at, consumed_by_device_id FROM invitations WHERE id = ?1`,
    )
      .bind(body.invitationId)
      .first<{ consumed_at: number | null; consumed_by_device_id: string | null }>();
    expect(invitation?.consumed_at).not.toBeNull();
    expect(invitation?.consumed_by_device_id).toBe(accepted.deviceId);

    const replay = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }),
    });
    expect(replay.status).toBe(409);
  });

  it("rejects an invalid confirmation code without mutating pairing state", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: "000000" }),
    });
    expect(response.status).toBe(400);

    const devices = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1`,
    )
      .bind(body.relationshipId)
      .first<{ count: number }>();
    expect(devices?.count).toBe(1);
  });

  it("rejects an expired invitation without creating the second device", async () => {
    const body = await bootstrap();
    await env.DB.prepare(`UPDATE invitations SET expires_at = ?1 WHERE id = ?2`)
      .bind(Date.now() - 1, body.invitationId)
      .run();

    const response = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }),
    });
    expect(response.status).toBe(400);

    const devices = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1`,
    )
      .bind(body.relationshipId)
      .first<{ count: number }>();
    expect(devices?.count).toBe(1);
  });

  it("allows a pairing invitation to be regenerated by the first authenticated device", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/pairing/create", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresInSeconds: 120 }),
    });

    expect(response.status).toBe(201);
    const replacement = await json(response);
    expect(replacement.relationshipId).toBe(body.relationshipId);
    expect(replacement.token).not.toBe(body.token);
  });

  it("lets only one of many concurrent accepts consume an invitation", async () => {
    const body = await bootstrap();
    const requests = Array.from({ length: 10 }, () =>
      exports.default.fetch("https://rucola.test/v1/pairing/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token, confirmationCode: body.confirmationCode }),
      }),
    );

    const responses = await Promise.all(requests);
    const successful = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(successful).toHaveLength(1);
    expect(conflicts).toHaveLength(9);

    const devices = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM devices WHERE relationship_id = ?1`,
    )
      .bind(body.relationshipId)
      .first<{ count: number }>();
    expect(devices?.count).toBe(2);
  });

  it("does not trust a client-supplied relationship or participant", async () => {
    const body = await bootstrap();
    const response = await exports.default.fetch("https://rucola.test/v1/auth/probe", {
      headers: { authorization: `Bearer ${body.credential}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true, participant: "ME" });
  });

  it("routes sync endpoints by their current implementation status", async () => {
    const push = await exports.default.fetch("https://rucola.test/v1/sync/push", { method: "POST" });
    expect(push.status).toBe(401);
    const pull = await exports.default.fetch("https://rucola.test/v1/sync/pull");
    expect(pull.status).toBe(401);
    const ack = await exports.default.fetch("https://rucola.test/v1/sync/ack/message-test", { method: "POST" });
    expect(ack.status).toBe(501);
  });
});
