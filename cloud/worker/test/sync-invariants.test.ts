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

let bootstrapTestId = 400;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `192.0.2.${bootstrapTestId % 255 || 1}`,
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
  return { me };
}

function validMailboxInsert(
  me: BootstrapBody,
  messageId: string,
  serverSeq: number,
  mediaUploadId: string | null = null,
  type = "TEXT",
) {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO mailbox_messages
       (relationship_id, message_id, sender_device_id, sender_participant, sender_seq,
        client_created_at, server_seq, server_received_at, type, ciphertext,
        encryption_version, media_upload_id, expires_at)
     VALUES (?1, ?2, ?3, 'ME', 1, ?4, ?5, ?4, ?6, ?7, 1, ?8, ?9)`,
  ).bind(
    me.relationshipId,
    messageId,
    me.deviceId,
    now,
    serverSeq,
    type,
    new TextEncoder().encode("invariant-test"),
    mediaUploadId,
    now + 7 * 24 * 60 * 60 * 1000,
  );
}

async function insertReadyMedia(me: BootstrapBody, mediaType: "PHOTO" | "VIDEO" | "DRAWING") {
  const mediaId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO media_uploads
       (id, relationship_id, created_by_device_id, object_key, media_type, declared_mime,
        size_bytes, status, created_at, expires_at, completed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, 'READY', ?7, ?8, ?7)`,
  ).bind(
    mediaId,
    me.relationshipId,
    me.deviceId,
    `test/${mediaId}`,
    mediaType,
    mediaType === "PHOTO" ? "image/jpeg" : mediaType === "VIDEO" ? "video/mp4" : "application/octet-stream",
    now - 60 * 60 * 1000,
    now + 60 * 60 * 1000,
  ).run();
  return mediaId;
}

describe("mailbox acceptance invariants", () => {
  it("rejects a mailbox row that does not consume the expected server sequence", async () => {
    const { me } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();

    await expect(validMailboxInsert(me, messageId, 99).run()).rejects.toThrow(/sequence invariant/i);

    const mailbox = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2")
      .bind(me.relationshipId, messageId)
      .first<{ count: number }>();
    const relationship = await env.DB
      .prepare("SELECT next_server_seq FROM relationships WHERE id = ?1")
      .bind(me.relationshipId)
      .first<{ next_server_seq: number }>();

    expect(mailbox?.count).toBe(0);
    expect(relationship?.next_server_seq).toBe(1);
  });

  it("rolls back mailbox insertion when its media upload cannot be attached", async () => {
    const { me } = await bootstrapAndAccept();
    const mediaId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const createdAt = now - 60 * 60 * 1000;
    const expiredAt = now - 1;

    await env.DB.prepare(
      `INSERT INTO media_uploads
         (id, relationship_id, created_by_device_id, object_key, media_type, declared_mime,
          size_bytes, status, created_at, expires_at, completed_at)
       VALUES (?1, ?2, ?3, ?4, 'PHOTO', 'image/jpeg', 10, 'READY', ?5, ?6, ?5)`,
    ).bind(
      mediaId,
      me.relationshipId,
      me.deviceId,
      `test/${mediaId}`,
      createdAt,
      expiredAt,
    ).run();

    await expect(validMailboxInsert(me, messageId, 1, mediaId, "PHOTO_VIDEO").run()).rejects.toThrow(/media invariant/i);

    const mailbox = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2")
      .bind(me.relationshipId, messageId)
      .first<{ count: number }>();
    const media = await env.DB
      .prepare("SELECT status, attached_at FROM media_uploads WHERE id = ?1")
      .bind(mediaId)
      .first<{ status: string; attached_at: number | null }>();
    const relationship = await env.DB
      .prepare("SELECT next_server_seq FROM relationships WHERE id = ?1")
      .bind(me.relationshipId)
      .first<{ next_server_seq: number }>();

    expect(mailbox?.count).toBe(0);
    expect(media?.status).toBe("READY");
    expect(media?.attached_at).toBeNull();
    expect(relationship?.next_server_seq).toBe(1);
  });

  it("rejects a PHOTO_VIDEO message without media at the database boundary", async () => {
    const { me } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();

    await expect(validMailboxInsert(me, messageId, 1, null, "PHOTO_VIDEO").run())
      .rejects.toThrow(/requires media upload/i);
  });

  it("rejects non-media messages that reference an upload", async () => {
    const { me } = await bootstrapAndAccept();
    const mediaId = await insertReadyMedia(me, "PHOTO");
    const messageId = crypto.randomUUID();

    await expect(validMailboxInsert(me, messageId, 1, mediaId, "TEXT").run())
      .rejects.toThrow(/cannot reference media upload/i);
  });

  it("rejects PHOTO_VIDEO messages that reference a drawing upload", async () => {
    const { me } = await bootstrapAndAccept();
    const mediaId = await insertReadyMedia(me, "DRAWING");
    const messageId = crypto.randomUUID();

    await expect(validMailboxInsert(me, messageId, 1, mediaId, "PHOTO_VIDEO").run())
      .rejects.toThrow(/incompatible media upload/i);
  });

  it("accepts PHOTO_VIDEO messages with a PHOTO or VIDEO upload", async () => {
    for (const mediaType of ["PHOTO", "VIDEO"] as const) {
      const { me } = await bootstrapAndAccept();
      const mediaId = await insertReadyMedia(me, mediaType);
      const messageId = crypto.randomUUID();

      await expect(validMailboxInsert(me, messageId, 1, mediaId, "PHOTO_VIDEO").run()).resolves.toBeDefined();

      const media = await env.DB
        .prepare("SELECT status, attached_at FROM media_uploads WHERE id = ?1")
        .bind(mediaId)
        .first<{ status: string; attached_at: number | null }>();
      expect(media?.status).toBe("ATTACHED");
      expect(media?.attached_at).not.toBeNull();
    }
  });
});
