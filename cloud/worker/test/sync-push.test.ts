import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface BootstrapBody { relationshipId: string; deviceId: string; credential: string; token: string; confirmationCode: string; }
interface AcceptedBody { relationshipId: string; deviceId: string; credential: string; participant: string; }
interface PushBody { messageId: string; senderSeq: number; type: string; ciphertext: string; encryptionVersion: number; createdAt: number; mediaUploadId?: string; }

async function json(response: Response): Promise<Record<string, unknown>> { return (await response.json()) as Record<string, unknown>; }
let bootstrapTestId = 0;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody; partner: AcceptedBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${bootstrapTestId}` },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(bootstrapResponse.status).toBe(201);
  const me = (await json(bootstrapResponse)) as unknown as BootstrapBody;
  const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }) });
  expect(acceptResponse.status).toBe(201);
  return { me, partner: (await json(acceptResponse)) as unknown as AcceptedBody };
}

function pushRequest(credential: string, overrides: Partial<PushBody> = {}): RequestInit {
  const body: PushBody = { messageId: crypto.randomUUID(), senderSeq: 1, type: "TEXT", ciphertext: "ciphertext-1", encryptionVersion: 1, createdAt: Date.now(), ...overrides };
  return { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) };
}
async function push(credential: string, overrides: Partial<PushBody> = {}): Promise<Response> { return exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(credential, overrides)); }

async function insertReadyMedia(relationshipId: string, deviceId: string, mediaId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO media_uploads (id, relationship_id, created_by_device_id, object_key, media_type, declared_mime, size_bytes, status, created_at, expires_at, completed_at) VALUES (?1, ?2, ?3, ?4, 'PHOTO', 'image/jpeg', 10, 'READY', ?5, ?6, ?5)`).bind(mediaId, relationshipId, deviceId, `test/${mediaId}`, now, now + 3600000).run();
}

describe("Rucola mailbox push", () => {
  it("accepts a first message and allocates serverSeq exactly once", async () => {
    const { me } = await bootstrapAndAccept(); const messageId = crypto.randomUUID(); const response = await push(me.credential, { messageId, senderSeq: 7 });
    expect(response.status).toBe(200); const body = await json(response); expect(body.messageId).toBe(messageId); expect(body.senderSeq).toBe(7); expect(body.serverSeq).toBe(1); expect(typeof body.acceptedAt).toBe("number");
    const row = await env.DB.prepare("SELECT sender_device_id, sender_participant, sender_seq, server_seq FROM mailbox_messages WHERE message_id = ?1").bind(messageId).first<{ sender_device_id: string; sender_participant: string; sender_seq: number; server_seq: number }>();
    const relationship = await env.DB.prepare("SELECT next_server_seq FROM relationships WHERE id = ?1").bind(me.relationshipId).first<{ next_server_seq: number }>();
    expect(row?.sender_device_id).toBe(me.deviceId); expect(row?.sender_participant).toBe("ME"); expect(row?.sender_seq).toBe(7); expect(row?.server_seq).toBe(1); expect(relationship?.next_server_seq).toBe(2);
  });

  it("returns the original result for an exact retry without advancing state", async () => {
    const { me } = await bootstrapAndAccept(); const messageId = crypto.randomUUID(); const body: PushBody = { messageId, senderSeq: 4, type: "TEXT", ciphertext: "stable", encryptionVersion: 1, createdAt: Date.now() };
    const first = await exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, body)); const firstBody = await json(first);
    const second = await exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, body)); const secondBody = await json(second);
    expect(first.status).toBe(200); expect(second.status).toBe(200); expect(secondBody).toEqual(firstBody);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2").bind(me.relationshipId, messageId).first<{ count: number }>();
    const relationship = await env.DB.prepare("SELECT next_server_seq FROM relationships WHERE id = ?1").bind(me.relationshipId).first<{ next_server_seq: number }>();
    expect(count?.count).toBe(1); expect(relationship?.next_server_seq).toBe(2);
  });

  it("handles concurrent exact retries idempotently", async () => {
    const { me } = await bootstrapAndAccept(); const messageId = crypto.randomUUID(); const responses = await Promise.all(Array.from({ length: 10 }, () => exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(me.credential, { messageId, senderSeq: 9, ciphertext: "same" }))));
    const bodies = await Promise.all(responses.map(json)); expect(responses.every((response) => response.status === 200)).toBe(true); expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2").bind(me.relationshipId, messageId).first<{ count: number }>(); const relationship = await env.DB.prepare("SELECT next_server_seq FROM relationships WHERE id = ?1").bind(me.relationshipId).first<{ next_server_seq: number }>();
    expect(count?.count).toBe(1); expect(relationship?.next_server_seq).toBe(2);
  });

  it("rejects a conflicting payload for an existing message ID", async () => {
    const { me } = await bootstrapAndAccept(); const messageId = crypto.randomUUID(); expect((await push(me.credential, { messageId, senderSeq: 1, ciphertext: "original" })).status).toBe(200);
    const response = await push(me.credential, { messageId, senderSeq: 1, ciphertext: "tampered" }); expect(response.status).toBe(409); expect((await json(response)).error).toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
  });

  it("rejects reuse of a sender sequence for another message", async () => {
    const { me } = await bootstrapAndAccept(); expect((await push(me.credential, { senderSeq: 12, ciphertext: "first" })).status).toBe(200); const response = await push(me.credential, { senderSeq: 12, ciphertext: "second" });
    expect(response.status).toBe(409); expect((await json(response)).error).toMatchObject({ code: "SENDER_SEQUENCE_CONFLICT" });
  });

  it("accepts gaps and out-of-order sender sequences", async () => {
    const { me } = await bootstrapAndAccept(); const high = await push(me.credential, { senderSeq: 12, ciphertext: "twelve" }); const low = await push(me.credential, { senderSeq: 10, ciphertext: "ten" }); expect(high.status).toBe(200); expect(low.status).toBe(200);
    const rows = await env.DB.prepare("SELECT sender_seq, server_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq").bind(me.relationshipId).all<{ sender_seq: number; server_seq: number }>(); expect(rows.results.map((row) => [row.sender_seq, row.server_seq])).toEqual([[12, 1], [10, 2]]);
  });

  it("serializes concurrent distinct messages with unique server sequences", async () => {
    const { me } = await bootstrapAndAccept(); const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => push(me.credential, { senderSeq: index + 1, ciphertext: `cipher-${index + 1}` })));
    expect(responses.every((response) => response.status === 200)).toBe(true); const rows = await env.DB.prepare("SELECT server_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq").bind(me.relationshipId).all<{ server_seq: number }>(); expect(rows.results.map((row) => row.server_seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("rejects pushes from revoked devices", async () => {
    const { me } = await bootstrapAndAccept(); await env.DB.prepare("UPDATE devices SET revoked_at = ?1 WHERE id = ?2").bind(Date.now(), me.deviceId).run(); expect((await push(me.credential, { senderSeq: 1 })).status).toBe(401);
  });

  it("rejects pushes while the relationship is still pairing", async () => {
    bootstrapTestId += 1; const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${bootstrapTestId}` }, body: JSON.stringify({ expiresInSeconds: 3600 }) });
    const me = (await json(bootstrapResponse)) as unknown as BootstrapBody; const response = await push(me.credential, { senderSeq: 1 }); expect(response.status).toBe(409); expect((await json(response)).error).toMatchObject({ code: "RELATIONSHIP_INACTIVE" });
  });

  it("rejects pushes after a relationship ends", async () => {
    const { me } = await bootstrapAndAccept(); await env.DB.prepare("UPDATE relationships SET status = 'ENDED', ended_at = ?1 WHERE id = ?2").bind(Date.now(), me.relationshipId).run(); const response = await push(me.credential, { senderSeq: 1 }); expect(response.status).toBe(409); expect((await json(response)).error).toMatchObject({ code: "RELATIONSHIP_INACTIVE" });
  });

  it("rejects malformed, unsupported, and oversized payloads", async () => {
    const { me } = await bootstrapAndAccept(); const malformed = await exports.default.fetch("https://rucola.test/v1/sync/push", { method: "POST", headers: { authorization: `Bearer ${me.credential}`, "content-type": "application/json" }, body: "null" });
    expect(malformed.status).toBe(400); expect((await push(me.credential, { type: "VIDEO" })).status).toBe(400); expect((await push(me.credential, { ciphertext: "x".repeat(13 * 1024) })).status).toBe(413);
  });

  it("does not trust client-supplied relationship or participant fields", async () => {
    const { me } = await bootstrapAndAccept(); const body = { messageId: crypto.randomUUID(), senderSeq: 1, type: "TEXT", ciphertext: "opaque", encryptionVersion: 1, createdAt: Date.now(), relationshipId: "attacker-controlled", participant: "PARTNER" };
    const response = await exports.default.fetch("https://rucola.test/v1/sync/push", { method: "POST", headers: { authorization: `Bearer ${me.credential}`, "content-type": "application/json" }, body: JSON.stringify(body) }); expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT relationship_id, sender_participant FROM mailbox_messages WHERE message_id = ?1").bind(body.messageId).first<{ relationship_id: string; sender_participant: string }>(); expect(row?.relationship_id).toBe(me.relationshipId); expect(row?.sender_participant).toBe("ME");
  });

  it("attaches only an owned READY media upload", async () => {
    const { me, partner } = await bootstrapAndAccept(); const mediaId = crypto.randomUUID(); await insertReadyMedia(me.relationshipId, me.deviceId, mediaId); const createdAt = Date.now(); const response = await push(me.credential, { type: "PHOTO_VIDEO", mediaUploadId: mediaId, ciphertext: "photo-meta", createdAt }); expect(response.status).toBe(200);
    const media = await env.DB.prepare("SELECT status FROM media_uploads WHERE id = ?1").bind(mediaId).first<{ status: string }>(); const mailbox = await env.DB.prepare("SELECT media_upload_id FROM mailbox_messages WHERE relationship_id = ?1 AND media_upload_id = ?2").bind(me.relationshipId, mediaId).first<{ media_upload_id: string }>(); expect(media?.status).toBe("ATTACHED"); expect(mailbox?.media_upload_id).toBe(mediaId);
    const retry = await push(me.credential, { type: "PHOTO_VIDEO", mediaUploadId: mediaId, ciphertext: "photo-meta", createdAt }); expect(retry.status).toBe(200); const otherMediaId = crypto.randomUUID(); await insertReadyMedia(me.relationshipId, partner.deviceId, otherMediaId); const ownership = await push(me.credential, { type: "PHOTO_VIDEO", mediaUploadId: otherMediaId, ciphertext: "other-photo" }); expect(ownership.status).toBe(409); expect((await json(ownership)).error).toMatchObject({ code: "MEDIA_CONFLICT" });
  });

  it("does not allow one media upload to be attached to two messages concurrently", async () => {
    const { me } = await bootstrapAndAccept(); const mediaId = crypto.randomUUID(); await insertReadyMedia(me.relationshipId, me.deviceId, mediaId); const responses = await Promise.all([push(me.credential, { senderSeq: 1, type: "PHOTO_VIDEO", mediaUploadId: mediaId, ciphertext: "photo-a" }), push(me.credential, { senderSeq: 2, type: "PHOTO_VIDEO", mediaUploadId: mediaId, ciphertext: "photo-b" })]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1); expect(responses.filter((response) => response.status === 409)).toHaveLength(1); const mailbox = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1 AND media_upload_id = ?2").bind(me.relationshipId, mediaId).first<{ count: number }>(); const media = await env.DB.prepare("SELECT status FROM media_uploads WHERE id = ?1").bind(mediaId).first<{ status: string }>(); expect(mailbox?.count).toBe(1); expect(media?.status).toBe("ATTACHED");
  });

  it("rolls back a failed server-sequence allocation without consuming state", async () => {
    const { me } = await bootstrapAndAccept(); expect((await push(me.credential, { senderSeq: 1, ciphertext: "existing" })).status).toBe(200); await env.DB.prepare("UPDATE relationships SET next_server_seq = 1 WHERE id = ?1").bind(me.relationshipId).run(); const failed = await push(me.credential, { senderSeq: 2, ciphertext: "should-not-stick" }); expect(failed.status).toBe(500);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1").bind(me.relationshipId).first<{ count: number }>(); const relationship = await env.DB.prepare("SELECT next_server_seq FROM relationships WHERE id = ?1").bind(me.relationshipId).first<{ next_server_seq: number }>(); expect(count?.count).toBe(1); expect(relationship?.next_server_seq).toBe(1);
  });
});
