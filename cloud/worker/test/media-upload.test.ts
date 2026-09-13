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
    body: bytes as unknown as BodyInit,
  });
}

async function completeMedia(credential: string, uploadId: string): Promise<Response> {
  return exports.default.fetch(`https://rucola.test/v1/media/${uploadId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
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

  it("completes an uploaded object and is idempotent", async () => {
    const { me } = await bootstrapAndAccept();
    const bytes = new TextEncoder().encode("rucola-media");
    const uploadId = await createMedia(me.credential, bytes.byteLength);
    expect((await uploadMedia(me.credential, uploadId, bytes)).status).toBe(200);

    const first = await completeMedia(me.credential, uploadId);
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ uploadId, status: "READY" });

    const row = await env.DB.prepare(
      "SELECT status, completed_at, expires_at, created_at FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ status: string; completed_at: number | null; expires_at: number; created_at: number }>();
    expect(row?.status).toBe("READY");
    expect(row?.completed_at).not.toBeNull();
    expect(row!.expires_at - row!.completed_at!).toBe(14 * 24 * 60 * 60 * 1000);
    expect(row!.expires_at).toBeGreaterThan(row!.created_at);

    const second = await completeMedia(me.credential, uploadId);
    expect(second.status).toBe(200);
    expect(await json(second)).toEqual({ uploadId, status: "READY" });
  });

  it("rejects completion before upload without changing the reservation", async () => {
    const { me } = await bootstrapAndAccept();
    const uploadId = await createMedia(me.credential, 3);

    const response = await completeMedia(me.credential, uploadId);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "MEDIA_NOT_UPLOADED" });

    const row = await env.DB.prepare(
      "SELECT status, completed_at FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ status: string; completed_at: number | null }>();
    expect(row).toEqual({ status: "PENDING", completed_at: null });
  });

  it("verifies the declared SHA-256 during upload and completion", async () => {
    const { me } = await bootstrapAndAccept();
    const bytes = new TextEncoder().encode("rucola-media");
    const checksum = "0b7381118933b71533218ca79d020e4a3075e6db5cb7e611f4d49eede55a3e74";
    const uploadId = await createMedia(me.credential, bytes.byteLength, checksum);

    const uploaded = await uploadMedia(me.credential, uploadId, bytes);
    expect(uploaded.status).toBe(200);
    const completed = await completeMedia(me.credential, uploadId);
    expect(completed.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT status FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ status: string }>();
    expect(row?.status).toBe("READY");
  });

  it("rejects completion if a checksum-protected object is replaced with different content", async () => {
    const { me } = await bootstrapAndAccept();
    const bytes = new TextEncoder().encode("rucola-media");
    const tamperedBytes = new TextEncoder().encode("rucola-mediX");
    const checksum = "0b7381118933b71533218ca79d020e4a3075e6db5cb7e611f4d49eede55a3e74";
    const uploadId = await createMedia(me.credential, bytes.byteLength, checksum);
    expect((await uploadMedia(me.credential, uploadId, bytes)).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT object_key FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ object_key: string }>();
    await env.MEDIA_BUCKET.put(row!.object_key, tamperedBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { uploadId },
    });

    const response = await completeMedia(me.credential, uploadId);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "MEDIA_STORAGE_MISMATCH" });
    expect(await env.MEDIA_BUCKET.head(row!.object_key)).toBeNull();

    const state = await env.DB.prepare(
      "SELECT status FROM media_uploads WHERE id = ?1",
    ).bind(uploadId).first<{ status: string }>();
    expect(state?.status).toBe("PENDING");
  });

  it("rejects completion from the other paired device", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const bytes = new Uint8Array([1, 2, 3]);
    const uploadId = await createMedia(me.credential, bytes.byteLength);
    expect((await uploadMedia(me.credential, uploadId, bytes)).status).toBe(200);

    const response = await completeMedia(partner.credential, uploadId);
    expect(response.status).toBe(404);
  });
});