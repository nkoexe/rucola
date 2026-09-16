import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function pair(): Promise<{ me: Record<string, unknown>; partner: Record<string, unknown> }> {
  const bootstrap = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.77" },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(bootstrap.status).toBe(201);
  const me = await json(bootstrap);
  const accept = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }),
  });
  expect(accept.status).toBe(201);
  return { me, partner: await json(accept) };
}

describe("media/message acceptance lifecycle", () => {
  it("moves READY media to ATTACHED when a media message is accepted", async () => {
    const { me } = await pair();
    const credential = me.credential as string;
    const reservation = await exports.default.fetch("https://rucola.test/v1/media/create", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "PHOTO", mime: "image/png", size: 4 }),
    });
    expect(reservation.status).toBe(201);
    const uploadId = (await json(reservation)).uploadId as string;

    const upload = await exports.default.fetch(`https://rucola.test/v1/media/${uploadId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${credential}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3, 4]) as unknown as BodyInit,
    });
    expect(upload.status).toBe(200);

    const complete = await exports.default.fetch(`https://rucola.test/v1/media/${uploadId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(complete.status).toBe(200);

    const push = await exports.default.fetch("https://rucola.test/v1/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({
        messageId: crypto.randomUUID(), senderSeq: 1, type: "PHOTO_VIDEO", ciphertext: "ciphertext",
        encryptionVersion: 1, createdAt: Date.now(), mediaUploadId: uploadId,
      }),
    });
    expect(push.status).toBe(200);

    const row = await env.DB.prepare("SELECT status FROM media_uploads WHERE id = ?")
      .bind(uploadId).first<{ status: string }>();
    expect(row?.status).toBe("ATTACHED");
  });
});
