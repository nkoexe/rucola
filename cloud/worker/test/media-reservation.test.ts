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

let bootstrapTestId = 700;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody; partner: BootstrapBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.51.100.${((bootstrapTestId - 1) % 254) + 1}`,
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

async function createMedia(
  credential: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/media/create", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("media reservation", () => {
  it("creates a PHOTO reservation within the image limit", async () => {
    const { me } = await bootstrapAndAccept();
    const response = await createMedia(me.credential, {
      type: "PHOTO",
      mime: "image/jpeg",
      size: 20 * 1024 * 1024,
    });

    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toMatchObject({
      mediaType: "PHOTO",
      mime: "image/jpeg",
      size: 20 * 1024 * 1024,
      checksum: null,
      status: "PENDING",
    });
    expect(typeof body.uploadId).toBe("string");
    expect(typeof body.expiresAt).toBe("number");

    const row = await env.DB.prepare(
      `SELECT relationship_id, created_by_device_id, object_key, media_type,
              declared_mime, size_bytes, checksum, status
       FROM media_uploads WHERE id = ?1`,
    ).bind(body.uploadId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      relationship_id: me.relationshipId,
      created_by_device_id: me.deviceId,
      media_type: "PHOTO",
      declared_mime: "image/jpeg",
      size_bytes: 20 * 1024 * 1024,
      checksum: null,
      status: "PENDING",
    });
    expect(typeof row?.object_key).toBe("string");
    expect(row?.object_key).toMatch(/^media\/[0-9a-f-]{36}$/);
  });

  it("creates a VIDEO reservation within the video limit", async () => {
    const { me } = await bootstrapAndAccept();
    const response = await createMedia(me.credential, {
      type: "VIDEO",
      mime: "video/mp4",
      size: 100 * 1024 * 1024,
      checksum: "A".repeat(64),
    });

    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({
      mediaType: "VIDEO",
      mime: "video/mp4",
      size: 100 * 1024 * 1024,
      checksum: "a".repeat(64),
      status: "PENDING",
    });
  });

  it("rejects unauthenticated reservations", async () => {
    const response = await exports.default.fetch("https://rucola.test/v1/media/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "PHOTO", mime: "image/jpeg", size: 1 }),
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects reservations while the relationship is inactive", async () => {
    const { me } = await bootstrapAndAccept();
    await env.DB.prepare(
      "UPDATE relationships SET status = 'ENDED', ended_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), me.relationshipId).run();

    const response = await createMedia(me.credential, {
      type: "PHOTO",
      mime: "image/jpeg",
      size: 1,
    });

    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "RELATIONSHIP_INACTIVE" });
  });

  it("rejects DRAWING because it is not in the initial usable media API", async () => {
    const { me } = await bootstrapAndAccept();
    const response = await createMedia(me.credential, {
      type: "DRAWING",
      mime: "image/png",
      size: 1,
    });

    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatchObject({ code: "INVALID_MEDIA_TYPE" });
  });

  it("rejects zero and non-integer sizes", async () => {
    const { me } = await bootstrapAndAccept();

    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await createMedia(me.credential, {
        type: "PHOTO",
        mime: "image/jpeg",
        size,
      });
      expect(response.status).toBe(400);
      expect((await json(response)).error).toMatchObject({ code: "INVALID_MEDIA_SIZE" });
    }
  });

  it("rejects media over type-specific limits", async () => {
    const { me } = await bootstrapAndAccept();

    const photo = await createMedia(me.credential, {
      type: "PHOTO",
      mime: "image/jpeg",
      size: 20 * 1024 * 1024 + 1,
    });
    expect(photo.status).toBe(413);
    expect((await json(photo)).error).toMatchObject({ code: "MEDIA_TOO_LARGE" });

    const video = await createMedia(me.credential, {
      type: "VIDEO",
      mime: "video/mp4",
      size: 100 * 1024 * 1024 + 1,
    });
    expect(video.status).toBe(413);
    expect((await json(video)).error).toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("rejects unsupported or mismatched MIME types", async () => {
    const { me } = await bootstrapAndAccept();

    for (const [type, mime] of [
      ["PHOTO", "video/mp4"],
      ["VIDEO", "image/jpeg"],
      ["PHOTO", "application/octet-stream"],
      ["VIDEO", "video/x-msvideo"],
    ]) {
      const response = await createMedia(me.credential, { type, mime, size: 1 });
      expect(response.status).toBe(400);
      expect((await json(response)).error).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    }
  });

  it("rejects malformed checksums", async () => {
    const { me } = await bootstrapAndAccept();
    const response = await createMedia(me.credential, {
      type: "PHOTO",
      mime: "image/jpeg",
      size: 1,
      checksum: "not-a-sha256",
    });

    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatchObject({ code: "INVALID_CHECKSUM" });
  });

  it("keeps reservations isolated between paired devices", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const response = await createMedia(partner.credential, {
      type: "PHOTO",
      mime: "image/png",
      size: 1234,
    });

    expect(response.status).toBe(201);
    const body = await json(response);
    const row = await env.DB.prepare(
      "SELECT relationship_id, created_by_device_id FROM media_uploads WHERE id = ?1",
    ).bind(body.uploadId).first<{ relationship_id: string; created_by_device_id: string }>();
    expect(row).toEqual({ relationship_id: me.relationshipId, created_by_device_id: partner.deviceId });
  });

  it("rejects oversized JSON bodies before parsing them", async () => {
    const { me } = await bootstrapAndAccept();
    const response = await createMedia(
      me.credential,
      { type: "PHOTO", mime: "image/jpeg", size: 1, padding: "x".repeat(20 * 1024) },
    );

    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
