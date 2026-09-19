import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface DeviceBody {
  relationshipId: string;
  deviceId: string;
  credential: string;
  token: string;
  confirmationCode: string;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function pair(): Promise<{ me: DeviceBody; partner: DeviceBody }> {
  const bootstrap = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${Math.floor(Math.random() * 200) + 1}` },
    body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }),
  });
  expect(bootstrap.status).toBe(201);
  const me = (await json(bootstrap)) as unknown as DeviceBody;
  const accept = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode, relationshipKeyCommitment: "a".repeat(64) }),
  });
  expect(accept.status).toBe(201);
  return { me, partner: (await json(accept)) as unknown as DeviceBody };
}

describe("message receipt delivery invariants", () => {
  it("rejects partial, self-device, and foreign-device delivery state", async () => {
    const { me, partner } = await pair();
    const push = await exports.default.fetch("https://rucola.test/v1/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${me.credential}`, "content-type": "application/json" },
      body: JSON.stringify({
        messageId: crypto.randomUUID(),
        senderSeq: 1,
        type: "TEXT",
        ciphertext: "delivery-invariant",
        encryptionVersion: 1,
        createdAt: Date.now(),
      }),
    });
    expect(push.status).toBe(200);
    const message = await json(push);

    const pull = await exports.default.fetch("https://rucola.test/v1/sync/pull", {
      headers: { authorization: `Bearer ${partner.credential}` },
    });
    expect(pull.status).toBe(200);

    const receipt = await env.DB.prepare(
      "SELECT message_id FROM message_receipts WHERE relationship_id = ?1 AND server_seq = ?2",
    ).bind(me.relationshipId, message.serverSeq).first<{ message_id: string }>();
    expect(receipt?.message_id).toBeDefined();

    await expect(
      env.DB.prepare("UPDATE message_receipts SET delivered_to_device_id = NULL, delivered_at = ?1 WHERE relationship_id = ?2 AND message_id = ?3")
        .bind(Date.now(), me.relationshipId, receipt!.message_id).run(),
    ).rejects.toThrow(/delivery fields must be set together/i);

    await expect(
      env.DB.prepare("UPDATE message_receipts SET delivered_to_device_id = ?1, delivered_at = ?2 WHERE relationship_id = ?3 AND message_id = ?4")
        .bind(me.deviceId, Date.now(), me.relationshipId, receipt!.message_id).run(),
    ).rejects.toThrow(/delivery device is invalid/i);

    await expect(
      env.DB.prepare("UPDATE message_receipts SET delivered_to_device_id = ?1, delivered_at = ?2 WHERE relationship_id = ?3 AND message_id = ?4")
        .bind(crypto.randomUUID(), Date.now(), me.relationshipId, receipt!.message_id).run(),
    ).rejects.toThrow(/delivery device is invalid/i);

    const state = await env.DB.prepare(
      "SELECT delivered_to_device_id, delivered_at FROM message_receipts WHERE relationship_id = ?1 AND message_id = ?2",
    ).bind(me.relationshipId, receipt!.message_id).first<{ delivered_to_device_id: string | null; delivered_at: number | null }>();
    expect(state?.delivered_to_device_id).toBe(partner.deviceId);
    expect(state?.delivered_at).not.toBeNull();
  });
});
