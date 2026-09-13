import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface PairingBody {
  relationshipId: string;
  deviceId: string;
  credential: string;
  token: string;
  confirmationCode: string;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let testId = 900;

async function bootstrapAndAccept(): Promise<{ me: PairingBody; partner: PairingBody }> {
  testId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `203.0.113.${((testId - 1) % 254) + 1}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(bootstrapResponse.status).toBe(201);
  const me = (await json(bootstrapResponse)) as unknown as PairingBody;

  const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }),
  });
  expect(acceptResponse.status).toBe(201);
  const partner = (await json(acceptResponse)) as unknown as PairingBody;
  return { me, partner };
}

async function createMedia(credential: string, size: number, checksum?: string): Promise<string> {
  const response = await exports.default.fetch("https://rucola.test/v1/media/create", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "PHOTO",
      mime: "image/png",
      size,
      ...(checksum === undefined ? {} : { checksum }),
    }),
  });
  expect(response.status).toBe(201);
  return (await json(response)).uploadId as string;
}

async function uploadMedia(
  credential: string,
  uploadId: string,
  bytes: Uint8Array,
  contentType = "image/png",
): Promise<Response> {
  return exports.default.fetch(`https://rucola.test/v1/media/${uploadId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": contentType,
    },
    body: bytes,
  });
}

describe("media upload", () => {
  it("streams a reserved object to R2 and preserves its reservation metadata", async () => {
    const { me } = await bootstrapAndAccept();
    const bytes = new TextEncoder().encode("rucola-media");
    const uploadId = await createMedia(me.credential, bytes.byteLength);

    const response = await uploadMedia(me.credential, uploadId, bytes);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ uploadId, status: "UPLOADED" });

    const row = await env.DB.prepare(
      "SELECT object_key, status FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ object_key: string; status: string }>();
    expect(row).toEqual(expect.objectContaining({ status: "PENDING" }));

    const object = await env.MEDIA_BUCKET.head(row!.object_key);
    expect(object).not.toBeNull();
    expect(object!.size).toBe(bytes.byteLength);
    expect(object!.httpMetadata?.contentType).toBe("image/png");
    expect(object!.customMetadata?.uploadId).toBe(uploadId);
  });

  it("rejects a streamed request without Content-Length before writing to R2", async () => {
    const { me } = await bootstrapAndAccept();
    const bytes = new TextEncoder().encode("rucola-media");
    const uploadId = await createMedia(me.credential, bytes.byteLength);

    const request = new Request(`https://rucola.test/v1/media/${uploadId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${me.credential}`,
        "content-type": "image/png",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(411);

    const row = await env.DB.prepare(
      "SELECT object_key FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ object_key: string }>();
    expect(await env.MEDIA_BUCKET.head(row!.object_key)).toBeNull();
  });

  it("enforces ownership, MIME, expiry, and pending-state checks", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const bytes = new Uint8Array([1, 2, 3]);
    const uploadId = await createMedia(me.credential, bytes.byteLength);

    const wrongOwner = await uploadMedia(partner.credential, uploadId, bytes);
    expect(wrongOwner.status).toBe(404);

    const wrongMime = await uploadMedia(me.credential, uploadId, bytes, "image/jpeg");
    expect(wrongMime.status).toBe(400);
    expect((await json(wrongMime)).error).toMatchObject({ code: "CONTENT_TYPE_MISMATCH" });

    await env.DB.prepare(
      "UPDATE media_uploads SET expires_at = ?1 WHERE id = ?2",
    ).bind(Date.now() - 1, uploadId).run();
    const expired = await uploadMedia(me.credential, uploadId, bytes);
    expect(expired.status).toBe(409);
    expect((await json(expired)).error).toMatchObject({ code: "MEDIA_EXPIRED" });

    const freshUploadId = await createMedia(me.credential, bytes.byteLength);
    await env.DB.prepare(
      "UPDATE media_uploads SET status = 'READY', completed_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), freshUploadId).run();
    const notPending = await uploadMedia(me.credential, freshUploadId, bytes);
    expect(notPending.status).toBe(409);
    expect((await json(notPending)).error).toMatchObject({ code: "MEDIA_NOT_PENDING" });
  });
});
