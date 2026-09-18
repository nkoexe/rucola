import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface DeviceBody {
  relationshipId: string;
  deviceId: string;
  credential: string;
  token: string;
  confirmationCode: string;
}

interface PushBody {
  messageId: string;
  senderSeq: number;
  type: "TEXT" | "EMOJI" | "PHOTO_VIDEO" | "DRAWING";
  ciphertext: string;
  encryptionVersion: number;
  createdAt: number;
}

interface PullBody {
  messages: Array<{
    messageId: string;
    senderDeviceId: string;
    senderParticipant: string;
    serverSeq: number;
  }>;
  nextCursor: number;
  hasMore: boolean;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let bootstrapTestId = 2000;

async function bootstrapAndAccept(): Promise<{ me: DeviceBody; partner: DeviceBody }> {
  bootstrapTestId += 1;
  const bootstrapResponse = await exports.default.fetch("https://rucola.test/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.18.${Math.floor(bootstrapTestId / 254)}.${(bootstrapTestId % 254) + 1}`,
    },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
  });
  expect(bootstrapResponse.status).toBe(201);
  const me = (await json(bootstrapResponse)) as unknown as DeviceBody;

  const acceptResponse = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: me.token, confirmationCode: me.confirmationCode }),
  });
  expect(acceptResponse.status).toBe(201);
  return { me, partner: (await json(acceptResponse)) as unknown as DeviceBody };
}

function pushRequest(credential: string, body: PushBody): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function push(credential: string, body: PushBody): Promise<Response> {
  return exports.default.fetch(
    "https://rucola.test/v1/sync/push",
    pushRequest(credential, body),
  );
}

async function pull(credential: string, query = ""): Promise<Response> {
  return exports.default.fetch(`https://rucola.test/v1/sync/pull${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${credential}` },
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

function bodyFor(overrides: Partial<PushBody> = {}): PushBody {
  return {
    messageId: crypto.randomUUID(),
    senderSeq: 1,
    type: "TEXT",
    ciphertext: "ciphertext",
    encryptionVersion: 1,
    createdAt: Date.now(),
    ...overrides,
  };
}

function decodeD1Blob(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (Array.isArray(value)) return new TextDecoder().decode(Uint8Array.from(value as number[]));
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError(`Unexpected D1 blob representation: ${Object.prototype.toString.call(value)}`);
}

describe("Rucola sync race hardening", () => {
  it("accepts concurrent pushes from both devices with the same sender sequence", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const meBody = bodyFor({ senderSeq: 1, ciphertext: "me-message" });
    const partnerBody = bodyFor({ senderSeq: 1, ciphertext: "partner-message" });

    const responses = await Promise.all([
      push(me.credential, meBody),
      push(partner.credential, partnerBody),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    const rows = await env.DB
      .prepare("SELECT server_seq, sender_device_id, sender_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq")
      .bind(me.relationshipId)
      .all<{ server_seq: number; sender_device_id: string; sender_seq: number }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results.map((row) => row.server_seq)).toEqual([1, 2]);
    expect(rows.results.map((row) => row.sender_seq)).toEqual([1, 1]);
    expect(new Set(rows.results.map((row) => row.sender_device_id))).toEqual(new Set([me.deviceId, partner.deviceId]));

    const relationship = await env.DB
      .prepare("SELECT next_server_seq FROM relationships WHERE id = ?1")
      .bind(me.relationshipId)
      .first<{ next_server_seq: number }>();
    expect(relationship?.next_server_seq).toBe(3);
  });

  it("serializes concurrent same-device pushes that reuse one sender sequence", async () => {
    const { me } = await bootstrapAndAccept();
    const first = bodyFor({ senderSeq: 7, ciphertext: "first" });
    const second = bodyFor({ senderSeq: 7, ciphertext: "second" });

    const responses = await Promise.all([
      push(me.credential, first),
      push(me.credential, second),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict).toBeDefined();
    await expect(conflict!.json()).resolves.toMatchObject({
      error: { code: "SENDER_SEQUENCE_CONFLICT" },
    });

    const rows = await env.DB
      .prepare("SELECT message_id, sender_seq, server_seq FROM mailbox_messages WHERE relationship_id = ?1")
      .bind(me.relationshipId)
      .all<{ message_id: string; sender_seq: number; server_seq: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.sender_seq).toBe(7);
    expect([first.messageId, second.messageId]).toContain(rows.results[0]?.message_id);

    const relationship = await env.DB
      .prepare("SELECT next_server_seq FROM relationships WHERE id = ?1")
      .bind(me.relationshipId)
      .first<{ next_server_seq: number }>();
    expect(relationship?.next_server_seq).toBe(2);
  });

  it("resolves concurrent retries with the same message ID and different payloads deterministically", async () => {
    const { me } = await bootstrapAndAccept();
    const messageId = crypto.randomUUID();
    const first = bodyFor({ messageId, senderSeq: 11, ciphertext: "first" });
    const second = bodyFor({ messageId, senderSeq: 11, ciphertext: "tampered" });

    const responses = await Promise.all([
      push(me.credential, first),
      push(me.credential, second),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict).toBeDefined();
    await expect(conflict!.json()).resolves.toMatchObject({
      error: { code: "MESSAGE_ID_CONFLICT" },
    });

    const row = await env.DB
      .prepare("SELECT ciphertext, server_seq FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2")
      .bind(me.relationshipId, messageId)
      .first<{ ciphertext: unknown; server_seq: number }>();
    expect(row).not.toBeNull();
    expect(row?.server_seq).toBe(1);
    const ciphertext = decodeD1Blob(row?.ciphertext);
    expect([first.ciphertext, second.ciphertext]).toContain(ciphertext);

    const relationship = await env.DB
      .prepare("SELECT next_server_seq FROM relationships WHERE id = ?1")
      .bind(me.relationshipId)
      .first<{ next_server_seq: number }>();
    expect(relationship?.next_server_seq).toBe(2);
  });

  it("keeps concurrent duplicate pulls safe and permits one idempotent ACK after delivery", async () => {
    const { me, partner } = await bootstrapAndAccept();
    const first = bodyFor({ senderSeq: 1, ciphertext: "one" });
    const second = bodyFor({ senderSeq: 2, ciphertext: "two" });
    expect((await push(me.credential, first)).status).toBe(200);
    expect((await push(me.credential, second)).status).toBe(200);

    const pulls = await Promise.all([
      pull(partner.credential, "?limit=2"),
      pull(partner.credential, "?limit=2"),
    ]);

    expect(pulls.map((response) => response.status).sort()).toEqual([200, 200]);
    const pullBodies = (await Promise.all(pulls.map(json))) as unknown as PullBody[];
    for (const body of pullBodies) {
      expect(body.messages.map((message) => message.serverSeq)).toEqual([1, 2]);
      expect(body.nextCursor).toBe(2);
      expect(body.hasMore).toBe(false);
    }

    const responses = await Promise.all([
      ack(partner.credential, 2),
      ack(partner.credential, 2),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    const ackBodies = await Promise.all(responses.map(json));
    expect(ackBodies.map((body) => body.acknowledgedThrough)).toEqual([2, 2]);
    expect(ackBodies.map((body) => body.deleted).sort()).toEqual([0, 2]);

    const remaining = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE relationship_id = ?1")
      .bind(me.relationshipId)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  async function runCrossDeviceBurst(count: number): Promise<void> {
    const { me, partner } = await bootstrapAndAccept();
    const requests = Array.from({ length: count }, (_, index) => {
      const credential = index % 2 === 0 ? me.credential : partner.credential;
      return push(credential, bodyFor({
        senderSeq: Math.floor(index / 2) + 1,
        ciphertext: `race-${index}`,
      }));
    });

    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const rows = await env.DB
      .prepare(
        "SELECT server_seq, sender_device_id, sender_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq",
      )
      .bind(me.relationshipId)
      .all<{ server_seq: number; sender_device_id: string; sender_seq: number }>();

    expect(rows.results).toHaveLength(count);
    expect(rows.results.map((row) => row.server_seq)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    expect(new Set(rows.results.map((row) => row.sender_device_id))).toEqual(
      new Set([me.deviceId, partner.deviceId]),
    );
    expect(rows.results.map((row) => row.sender_seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, index) => Math.floor(index / 2) + 1),
    );

    const relationship = await env.DB
      .prepare("SELECT next_server_seq FROM relationships WHERE id = ?1")
      .bind(me.relationshipId)
      .first<{ next_server_seq: number }>();
    expect(relationship?.next_server_seq).toBe(count + 1);
  }

  it("handles a two-device burst of 10 concurrent sends", async () => {
    await runCrossDeviceBurst(10);
  });

  it("handles a two-device burst of 25 concurrent sends", async () => {
    await runCrossDeviceBurst(25);
  }, 15_000);

  it("makes a retry storm for one message idempotent", async () => {
    const { me } = await bootstrapAndAccept();
    const message = bodyFor({ senderSeq: 1, ciphertext: "retry-storm" });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => push(me.credential, message)),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(json));
    expect(new Set(bodies.map((body) => body.serverSeq))).toEqual(new Set([1]));

    const rows = await env.DB
      .prepare(
        "SELECT message_id, server_seq FROM mailbox_messages WHERE relationship_id = ?1 AND message_id = ?2",
      )
      .bind(me.relationshipId, message.messageId)
      .all<{ message_id: string; server_seq: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.server_seq).toBe(1);

    const receipts = await env.DB
      .prepare(
        "SELECT message_id, server_seq FROM message_receipts WHERE relationship_id = ?1 AND message_id = ?2",
      )
      .bind(me.relationshipId, message.messageId)
      .all<{ message_id: string; server_seq: number }>();
    expect(receipts.results).toHaveLength(1);
    expect(receipts.results[0]?.server_seq).toBe(1);
  }, 15_000);

  it("preserves server-sequence ordering across a larger cross-device race", async () => {
    await runCrossDeviceBurst(20);
  }, 15_000);
});
