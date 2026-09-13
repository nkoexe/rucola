import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface BootstrapBody {
  relationshipId: string;
  deviceId: string;
  credential: string;
  token: string;
  confirmationCode: string;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let bootstrapTestId = 200;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody; partner: BootstrapBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `203.0.113.${bootstrapTestId % 255}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(bootstrapResponse.status).toBe(201);
  const me = (await json(bootstrapResponse)) as unknown as BootstrapBody;

  const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }),
  });
  expect(acceptResponse.status).toBe(201);
  const partner = (await json(acceptResponse)) as unknown as BootstrapBody;
  return { me, partner };
}

function pushRequest(credential: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function ack(credential: string, throughServerSeq: unknown): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/sync/ack", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ throughServerSeq }),
  });
}

describe("durable message idempotency", () => {
  it("returns the original server sequence after the mailbox row is ACKed", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const message = {
      messageId: crypto.randomUUID(),
      senderSeq: 41,
      type: "TEXT",
      ciphertext: "durable-retry",
      encryptionVersion: 1,
      createdAt: Date.now(),
    };

    const first = await exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, message));
    const firstBody = await json(first);
    expect(first.status).toBe(200);

    const ackResponse = await ack(partner.credential, firstBody.serverSeq);
    expect(ackResponse.status).toBe(200);

    const mailbox = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2",
    ).bind(me.relationshipId, message.messageId).first<{ count: number }>();
    const receipt = await env.DB.prepare(
      "SELECT server_seq, acknowledged_at FROM message_receipts WHERE relationship_id = ?1 AND message_id = ?2",
    ).bind(me.relationshipId, message.messageId).first<{ server_seq: number; acknowledged_at: number | null }>();
    expect(mailbox?.count).toBe(0);
    expect(receipt?.server_seq).toBe(firstBody.serverSeq);
    expect(receipt?.acknowledged_at).not.toBeNull();

    const retry = await exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, message));
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual(firstBody);

    const relationship = await env.DB.prepare(
      "SELECT next_server_seq FROM relationships WHERE id = ?1",
    ).bind(me.relationshipId).first<{ next_server_seq: number }>();
    expect(relationship?.next_server_seq).toBe(2);
  });

  it("rejects a changed payload after the original mailbox row was ACKed", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();
    const createdAt = Date.now();
    const original = {
      messageId,
      senderSeq: 7,
      type: "TEXT",
      ciphertext: "original",
      encryptionVersion: 1,
      createdAt,
    };

    const first = await exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, original));
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect((await ack(partner.credential, firstBody.serverSeq)).status).toBe(200);

    const conflict = await exports.default.fetch(
      "https://rucola.test/v1/sync/push",
      pushRequest(me.credential, { ...original, ciphertext: "tampered" }),
    );
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error).toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
  });

  it("rejects sender sequence reuse after the original mailbox row was ACKed", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const first = {
      messageId: crypto.randomUUID(),
      senderSeq: 9,
      type: "TEXT",
      ciphertext: "first",
      encryptionVersion: 1,
      createdAt: Date.now(),
    };

    const response = await exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, first));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((await ack(partner.credential, body.serverSeq)).status).toBe(200);

    const conflict = await exports.default.fetch(
      "https://rucola.test/v1/sync/push",
      pushRequest(me.credential, { ...first, messageId: crypto.randomUUID(), ciphertext: "second" }),
    );
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error).toMatchObject({ code: "SENDER_SEQUENCE_CONFLICT" });
  });
});
