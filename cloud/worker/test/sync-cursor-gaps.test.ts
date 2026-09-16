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

let bootstrapTestId = 4000;

async function bootstrapAndAccept(): Promise<{ me: DeviceBody; partner: DeviceBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.20.${Math.floor(bootstrapTestId / 254)}.${(bootstrapTestId % 254) + 1}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(bootstrapResponse.status).toBe(201);
  const me = (await json(bootstrapResponse)) as unknown as DeviceBody;

  const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }),
  });
  expect(acceptResponse.status).toBe(201);
  return { me, partner: (await json(acceptResponse)) as unknown as DeviceBody };
}

async function push(credential: string, senderSeq: number): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/sync/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messageId: crypto.randomUUID(),
      senderSeq,
      type: "TEXT",
      ciphertext: `ciphertext-${senderSeq}-${crypto.randomUUID()}`,
      encryptionVersion: 1,
      createdAt: Date.now(),
    }),
  });
}

async function pull(credential: string, query = ""): Promise<Response> {
  return exports.default.fetch(`https://rucola.test/v1/sync/pull${query}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

async function ack(credential: string, throughServerSeq: number): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/sync/ack", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ throughServerSeq }),
  });
}

describe("Rucola expired cursor gaps", () => {
  it("allows an ACK past an expired earlier partner message when a later partner message was delivered", async () => {
    const { me, partner } = await bootstrapAndAccept();
    expect((await push(partner.credential, 1)).status).toBe(200);
    expect((await push(me.credential, 1)).status).toBe(200);
    expect((await push(partner.credential, 2)).status).toBe(200);

    await env.DB.prepare(
      "UPDATE mailbox_messages SET expires_at = ?1 WHERE relationship_id = ?2 AND server_seq = 1",
    ).bind(Date.now() - 1, me.relationshipId).run();

    const response = await pull(me.credential, "?after=0&limit=10");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((body.messages as Array<Record<string, unknown>>).map((message) => message.serverSeq)).toEqual([3]);
    expect(body.nextCursor).toBe(3);
    expect(body.hasMore).toBe(false);

    const acknowledgement = await ack(me.credential, 3);
    expect(acknowledgement.status).toBe(200);
    await expect(acknowledgement.json()).resolves.toMatchObject({
      acknowledgedThrough: 3,
      deleted: 1,
    });

    const remaining = await env.DB.prepare(
      "SELECT server_seq, sender_device_id FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq",
    ).bind(me.relationshipId).all<{ server_seq: number; sender_device_id: string }>();
    expect(remaining.results.map((row) => row.server_seq)).toEqual([1, 2]);
    expect(remaining.results[0]?.sender_device_id).toBe(partner.deviceId);
    expect(remaining.results[1]?.sender_device_id).toBe(me.deviceId);
  });
});
