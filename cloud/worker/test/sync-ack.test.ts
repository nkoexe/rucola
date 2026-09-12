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

let bootstrapTestId = 100;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody; partner: BootstrapBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `203.0.113.${bootstrapTestId}`,
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
  const accepted = (await json(acceptResponse)) as unknown as BootstrapBody;
  return { me, partner: accepted };
}

async function push(credential: string, senderSeq: number, messageId = crypto.randomUUID()): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/sync/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messageId,
      senderSeq,
      type: "TEXT",
      ciphertext: `ciphertext-${senderSeq}`,
      encryptionVersion: 1,
      createdAt: Date.now(),
    }),
  });
}

async function ack(credential: string, throughServerSeq: unknown): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/sync/ack", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ throughServerSeq }),
  });
}

describe("Rucola mailbox acknowledgement", () => {
  it("requires authentication and the exact ACK route", async () => {
    expect((await exports.default.fetch("https://rucola.test/v1/sync/ack", { method: "POST" })).status).toBe(401);
    expect((await exports.default.fetch("https://rucola.test/v1/sync/ack/message-test", { method: "POST" })).status).toBe(404);
  });

  it("rejects malformed, zero, and non-integer acknowledgement cursors", async () => {
    const { me } = await bootstrapAndAccept();
    for (const value of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      const response = await ack(me.credential, value);
      expect(response.status).toBe(400);
      expect((await json(response)).error).toMatchObject({ code: "INVALID_ACK_CURSOR" });
    }
  });

  it("rejects an acknowledgement beyond the server's known sequence", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);

    const response = await ack(me.credential, 2);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "ACK_CURSOR_AHEAD" });

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1",
    ).bind(me.relationshipId).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it("deletes mailbox messages through the acknowledged high-water mark", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);
    expect((await push(me.credential, 2)).status).toBe(200);
    expect((await push(me.credential, 3)).status).toBe(200);

    const response = await ack(me.credential, 2);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ acknowledgedThrough: 2, deleted: 2 });

    const rows = await env.DB.prepare(
      `SELECT server_seq FROM mailbox_messages
       WHERE relationship_id = ?1 ORDER BY server_seq`,
    ).bind(me.relationshipId).all<{ server_seq: number }>();
    expect(rows.results.map((row) => row.server_seq)).toEqual([3]);
  });

  it("is idempotent when the same acknowledgement is repeated", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);

    const first = await ack(me.credential, 1);
    const second = await ack(me.credential, 1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ acknowledgedThrough: 1, deleted: 0 });
  });

  it("cannot acknowledge another relationship's mailbox", async () => {
    const first = await bootstrapAndAccept();
    const second = await bootstrapAndAccept();
    expect((await push(second.me.credential, 1)).status).toBe(200);

    const response = await ack(first.me.credential, 1);
    expect(response.status).toBe(409);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1",
    ).bind(second.me.relationshipId).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it("does not remove a message pushed after an earlier acknowledgement", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);
    expect((await ack(me.credential, 1)).status).toBe(200);
    expect((await push(me.credential, 2)).status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT server_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq",
    ).bind(me.relationshipId).all<{ server_seq: number }>();
    expect(rows.results.map((row) => row.server_seq)).toEqual([2]);
  });

  it("acknowledges the sender's own messages as part of the relationship-wide cursor", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);
    expect((await ack(me.credential, 1)).status).toBe(200);

    const pull = await exports.default.fetch("https://rucola.test/v1/sync/pull?after=0", {
      headers: { authorization: `Bearer ${me.credential}` },
    });
    expect(pull.status).toBe(200);
    const body = await json(pull);
    expect(body.messages).toEqual([]);
  });
});
