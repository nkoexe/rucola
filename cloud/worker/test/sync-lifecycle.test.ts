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

let bootstrapTestId = 500;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody; partner: BootstrapBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `192.0.2.${((bootstrapTestId - 1) % 254) + 1}`,
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

async function pull(credential: string, after = 0): Promise<Response> {
  return exports.default.fetch(`https://rucola.test/v1/sync/pull?after=${after}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

describe("Rucola sync lifecycle hardening", () => {
  it("serializes concurrent ACKs without deleting messages beyond the cursor", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);
    expect((await push(me.credential, 2)).status).toBe(200);
    expect((await push(me.credential, 3)).status).toBe(200);

    const responses = await Promise.all([
      ack(me.credential, 2),
      ack(me.credential, 2),
      ack(me.credential, 2),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200]);
    const deletedCounts = await Promise.all(
      responses.map(async (response) => ((await json(response)).deleted as number)),
    );
    expect(deletedCounts.reduce((sum, count) => sum + count, 0)).toBe(2);

    const rows = await env.DB.prepare(
      "SELECT server_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq",
    ).bind(me.relationshipId).all<{ server_seq: number }>();
    expect(rows.results.map((row) => row.server_seq)).toEqual([3]);
  });

  it("does not ACK-delete mailbox rows after the relationship has ended", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);

    await env.DB.prepare(
      "UPDATE relationships SET status = 'ENDED', ended_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), me.relationshipId).run();

    const response = await ack(me.credential, 1);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "RELATIONSHIP_INACTIVE" });

    const rows = await env.DB.prepare(
      "SELECT server_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq",
    ).bind(me.relationshipId).all<{ server_seq: number }>();
    expect(rows.results.map((row) => row.server_seq)).toEqual([1]);
  });

  it("does not expose mailbox messages after relationship termination", async () => {
    const { me } = await bootstrapAndAccept();
    expect((await push(me.credential, 1)).status).toBe(200);

    await env.DB.prepare(
      "UPDATE relationships SET status = 'ENDED', ended_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), me.relationshipId).run();

    const response = await pull(me.credential);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "RELATIONSHIP_INACTIVE" });
  });
});
