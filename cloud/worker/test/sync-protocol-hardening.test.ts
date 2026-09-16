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

let bootstrapTestId = 3000;

async function bootstrapAndAccept(): Promise<BootstrapBody> {
  bootstrapTestId += 1;
  const response = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.19.${Math.floor(bootstrapTestId / 254)}.${(bootstrapTestId % 254) + 1}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(response.status).toBe(201);
  return (await json(response)) as unknown as BootstrapBody;
}

describe("Rucola sync protocol hardening", () => {
  it("keeps DRAWING in the protocol without allowing new DRAWING pushes", async () => {
    const me = await bootstrapAndAccept();
    const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }),
    });
    expect(acceptResponse.status).toBe(201);

    const response = await exports.default.fetch("https://rucola.test/v1/sync/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${me.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messageId: crypto.randomUUID(),
        senderSeq: 1,
        type: "DRAWING",
        ciphertext: "future-drawing",
        encryptionVersion: 1,
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "DRAWING synchronization is not implemented yet",
      },
    });

    const mailbox = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1")
      .bind(me.relationshipId)
      .first<{ count: number }>();
    expect(mailbox?.count).toBe(0);
  });
});
