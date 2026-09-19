import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface BootstrapBody {
  relationshipId: string;
  deviceId: string;
  credential: string;
  token: string;
  confirmationCode: string;
}

interface AcceptedBody {
  relationshipId: string;
  deviceId: string;
  credential: string;
  participant: string;
}

interface PushBody {
  messageId: string;
  senderSeq: number;
  type: string;
  ciphertext: string;
  encryptionVersion: number;
  createdAt: number;
}

interface PullBody {
  messages: Array<{
    messageId: string;
    senderDeviceId: string;
    senderParticipant: string;
    senderSeq: number;
    createdAt: number;
    serverSeq: number;
    receivedAt: number;
    type: string;
    ciphertext: string;
    encryptionVersion: number;
    mediaUploadId: string | null;
  }>;
  nextCursor: number;
  hasMore: boolean;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let bootstrapTestId = 100;

async function bootstrapAndAccept(): Promise<{ me: BootstrapBody; partner: AcceptedBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.51.100.${((bootstrapTestId - 1) % 254) + 1}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }),
  });
  expect(bootstrapResponse.status).toBe(201);
  const me = (await json(bootstrapResponse)) as unknown as BootstrapBody;

  const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: me.token,
      confirmationCode: me.confirmationCode, relationshipKeyCommitment: "a".repeat(64),
    }),
  });
  expect(acceptResponse.status).toBe(201);
  return { me, partner: (await json(acceptResponse)) as unknown as AcceptedBody };
}

function pushRequest(credential: string, overrides: Partial<PushBody> = {}): RequestInit {
  const body: PushBody = {
    messageId: crypto.randomUUID(),
    senderSeq: 1,
    type: "TEXT",
    ciphertext: "ciphertext-1",
    encryptionVersion: 1,
    createdAt: Date.now(),
    ...overrides,
  };
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function push(credential: string, overrides: Partial<PushBody> = {}): Promise<Response> {
  return exports.default.fetch("https://rucola.test/v1/sync/push", pushRequest(credential, overrides));
}

async function pull(credential: string, query = ""): Promise<Response> {
  return exports.default.fetch(`https://rucola.test/v1/sync/pull${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${credential}` },
  });
}

describe("Rucola mailbox pull", () => {
  it("rejects unauthenticated pulls", async () => {
    const response = await pull("invalid-credential");
    expect(response.status).toBe(401);
    expect((await json(response)).error).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects revoked device credentials", async () => {
    const { me } = await bootstrapAndAccept();
    await env.DB.prepare("UPDATE devices SET revoked_at = ?1 WHERE id = ?2").bind(Date.now(), me.deviceId).run();

    const response = await pull(me.credential);
    expect(response.status).toBe(401);
    expect((await json(response)).error).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("returns an empty mailbox at cursor zero", async () => {
    const { me } = await bootstrapAndAccept();
    const response = await pull(me.credential);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ messages: [], nextCursor: 0, hasMore: false });
  });

  it("does not return a device's own outbound messages", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();
    expect((await push(me.credential, { messageId, senderSeq: 1, ciphertext: "own-message" })).status).toBe(200);

    const senderPull = await pull(me.credential);
    expect(senderPull.status).toBe(200);
    expect(await json(senderPull)).toEqual({ messages: [], nextCursor: 0, hasMore: false });

    const partnerPull = await pull(partner.credential);
    expect(partnerPull.status).toBe(200);
    const body = (await json(partnerPull)) as unknown as PullBody;
    expect(body.messages.map((message) => message.messageId)).toEqual([messageId]);
    expect(body.messages[0]?.senderDeviceId).toBe(me.deviceId);
    expect(body.messages[0]?.senderParticipant).toBe("ME");
    expect(body.nextCursor).toBe(1);
  });

  it("returns partner messages in server sequence order", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const createdAt = Date.now();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const third = crypto.randomUUID();

    expect((await push(me.credential, { messageId: first, senderSeq: 30, ciphertext: "first", createdAt })).status).toBe(200);
    expect((await push(me.credential, { messageId: second, senderSeq: 10, ciphertext: "second", createdAt: createdAt + 1 })).status).toBe(200);
    expect((await push(me.credential, { messageId: third, senderSeq: 20, ciphertext: "third", createdAt: createdAt + 2 })).status).toBe(200);

    const response = await pull(partner.credential);
    expect(response.status).toBe(200);
    const body = (await json(response)) as unknown as PullBody;

    expect(body.messages.map((message) => message.messageId)).toEqual([first, second, third]);
    expect(body.messages.map((message) => message.serverSeq)).toEqual([1, 2, 3]);
    expect(body.messages.map((message) => message.senderSeq)).toEqual([30, 10, 20]);
    expect(body.messages.map((message) => message.ciphertext)).toEqual(["first", "second", "third"]);
    expect(body.nextCursor).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it("paginates partner messages with a bounded limit and a monotonic cursor", async () => {
    const { me, partner } = await bootstrapAndAccept();
    for (let index = 1; index <= 5; index += 1) {
      expect((await push(me.credential, { senderSeq: index, ciphertext: `cipher-${index}` })).status).toBe(200);
    }

    const firstPage = await pull(partner.credential, "?limit=2");
    expect(firstPage.status).toBe(200);
    const firstBody = (await json(firstPage)) as unknown as PullBody;
    expect(firstBody.messages.map((message) => message.serverSeq)).toEqual([1, 2]);
    expect(firstBody.nextCursor).toBe(2);
    expect(firstBody.hasMore).toBe(true);

    const secondPage = await pull(partner.credential, `?after=${firstBody.nextCursor}&limit=2`);
    expect(secondPage.status).toBe(200);
    const secondBody = (await json(secondPage)) as unknown as PullBody;
    expect(secondBody.messages.map((message) => message.serverSeq)).toEqual([3, 4]);
    expect(secondBody.nextCursor).toBe(4);
    expect(secondBody.hasMore).toBe(true);

    const finalPage = await pull(partner.credential, `?after=${secondBody.nextCursor}&limit=2`);
    expect(finalPage.status).toBe(200);
    const finalBody = (await json(finalPage)) as unknown as PullBody;
    expect(finalBody.messages.map((message) => message.serverSeq)).toEqual([5]);
    expect(finalBody.nextCursor).toBe(5);
    expect(finalBody.hasMore).toBe(false);
  });

  it("handles interleaved outbound messages with a partner-specific cursor", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const meFirst = crypto.randomUUID();
    const partnerFirst = crypto.randomUUID();
    const meSecond = crypto.randomUUID();

    expect((await push(me.credential, { messageId: meFirst, senderSeq: 1, ciphertext: "me-1" })).status).toBe(200);
    expect((await push(partner.credential, { messageId: partnerFirst, senderSeq: 1, ciphertext: "partner-1" })).status).toBe(200);
    expect((await push(me.credential, { messageId: meSecond, senderSeq: 2, ciphertext: "me-2" })).status).toBe(200);

    const partnerPull = await pull(partner.credential, "?after=0&limit=1");
    expect(partnerPull.status).toBe(200);
    const body = (await json(partnerPull)) as unknown as PullBody;
    expect(body.messages.map((message) => message.messageId)).toEqual([meFirst]);
    expect(body.nextCursor).toBe(1);
    expect(body.hasMore).toBe(true);

    const nextPartnerPull = await pull(partner.credential, `?after=${body.nextCursor}&limit=1`);
    expect(nextPartnerPull.status).toBe(200);
    const nextBody = (await json(nextPartnerPull)) as unknown as PullBody;
    expect(nextBody.messages.map((message) => message.messageId)).toEqual([meSecond]);
    expect(nextBody.nextCursor).toBe(3);
    expect(nextBody.hasMore).toBe(false);
    expect(nextBody.messages[0]?.serverSeq).toBe(3);
    expect(nextBody.messages[0]?.senderDeviceId).toBe(me.deviceId);
    expect(partnerFirst).not.toBe(nextBody.messages[0]?.messageId);
  });

  it("repeats unacknowledged partner messages when the cursor does not advance", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();
    expect((await push(me.credential, { messageId, senderSeq: 1, ciphertext: "retry-me" })).status).toBe(200);

    const first = await pull(partner.credential);
    const second = await pull(partner.credential);
    const firstBody = (await json(first)) as unknown as PullBody;
    const secondBody = (await json(second)) as unknown as PullBody;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
  });

  it("keeps the cursor stable when no eligible partner messages remain after it", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();
    expect((await push(me.credential, { messageId, senderSeq: 1, ciphertext: "expired" })).status).toBe(200);

    await env.DB.prepare("UPDATE mailbox_messages SET expires_at = ?1 WHERE relationship_id = ?2 AND message_id = ?3")
      .bind(Date.now() - 1, me.relationshipId, messageId).run();

    const response = await pull(partner.credential, "?after=0");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ messages: [], nextCursor: 0, hasMore: false });
  });

  it("allows a cursor beyond the current server sequence", async () => {
    const { partner } = await bootstrapAndAccept();
    const response = await pull(partner.credential, "?after=9007199254740991");

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ messages: [], nextCursor: 9007199254740991, hasMore: false });
  });

  it("does not return acknowledged or expired partner mailbox rows", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const acknowledgedId = crypto.randomUUID();
    const expiredId = crypto.randomUUID();
    const liveId = crypto.randomUUID();

    expect((await push(me.credential, { messageId: acknowledgedId, senderSeq: 1, ciphertext: "acknowledged" })).status).toBe(200);
    expect((await push(me.credential, { messageId: expiredId, senderSeq: 2, ciphertext: "expired" })).status).toBe(200);
    expect((await push(me.credential, { messageId: liveId, senderSeq: 3, ciphertext: "live" })).status).toBe(200);

    const now = Date.now();
    await env.DB.prepare("UPDATE mailbox_messages SET acknowledged_at = ?1 WHERE relationship_id = ?2 AND message_id = ?3")
      .bind(now, me.relationshipId, acknowledgedId).run();
    await env.DB.prepare("UPDATE mailbox_messages SET expires_at = ?1 WHERE relationship_id = ?2 AND message_id = ?3")
      .bind(now - 1, me.relationshipId, expiredId).run();

    const response = await pull(partner.credential);
    expect(response.status).toBe(200);
    const body = (await json(response)) as unknown as PullBody;

    expect(body.messages.map((message) => message.messageId)).toEqual([liveId]);
    expect(body.nextCursor).toBe(3);
  });

  it("does not leak messages across relationships", async () => {
    const first = await bootstrapAndAccept();
    const second = await bootstrapAndAccept();

    const foreignMessageId = crypto.randomUUID();
    expect((await push(first.me.credential, { messageId: foreignMessageId, senderSeq: 1, ciphertext: "foreign" })).status).toBe(200);

    const response = await pull(second.partner.credential);
    expect(response.status).toBe(200);
    const body = (await json(response)) as unknown as PullBody;
    expect(body.messages).toEqual([]);
    expect(body.nextCursor).toBe(0);
  });

  it("rejects invalid cursor and limit values", async () => {
    const { partner } = await bootstrapAndAccept();

    expect((await pull(partner.credential, "?after=-1")).status).toBe(400);
    expect((await pull(partner.credential, "?after=not-a-number")).status).toBe(400);
    expect((await pull(partner.credential, "?after=9007199254740992")).status).toBe(400);
    expect((await pull(partner.credential, "?after=")).status).toBe(400);
    expect((await pull(partner.credential, "?limit=0")).status).toBe(400);
    expect((await pull(partner.credential, "?limit=101")).status).toBe(400);
    expect((await pull(partner.credential, "?limit=abc")).status).toBe(400);
  });

  it("rejects pulls for inactive relationships", async () => {
    const { me } = await bootstrapAndAccept();
    await env.DB.prepare("UPDATE relationships SET status = 'ENDED', ended_at = ?1 WHERE id = ?2")
      .bind(Date.now(), me.relationshipId).run();

    const response = await pull(me.credential);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toMatchObject({ code: "RELATIONSHIP_INACTIVE" });
  });
});
