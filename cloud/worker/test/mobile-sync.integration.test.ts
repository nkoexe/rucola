import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CloudClient } from "../../../src/cloud/CloudClient";
import { SyncEngine } from "../../../src/sync/SyncEngine";
import type { CloudPulledMessage } from "../../../src/cloud/protocol";

type LocalMessage = {
  id: string;
  relationshipId: string;
  participant: "ME" | "PARTNER";
  type: "TEXT" | "EMOJI";
  body: string;
  createdAt: number;
  isActive: boolean;
  syncState: "PENDING" | "SYNCED";
  orderIndex: number;
  mediaReference: string | null;
};

type OutboxItem = {
  messageId: string;
  senderSeq: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  ciphertext: string | null;
  encryptionVersion: number | null;
  createdAt: number;
};

function pairingRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({ expiresInSeconds: 3600, relationshipKeyCommitment: "a".repeat(64) }),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function pair(): Promise<{
  relationshipId: string;
  meCredential: string;
  partnerCredential: string;
}> {
  const bootstrap = await exports.default.fetch(
    "https://rucola.test/v1/pairing/bootstrap",
    pairingRequest(),
  );
  expect(bootstrap.status).toBe(201);
  const invitation = await json(bootstrap);

  const accept = await exports.default.fetch("https://rucola.test/v1/pairing/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: invitation.token,
      confirmationCode: invitation.confirmationCode, relationshipKeyCommitment: "a".repeat(64),
    }),
  });
  expect(accept.status).toBe(201);
  const partner = await json(accept);

  return {
    relationshipId: invitation.relationshipId as string,
    meCredential: invitation.credential as string,
    partnerCredential: partner.credential as string,
  };
}

function message(
  relationshipId: string,
  id: string,
  body: string,
  orderIndex: number,
): LocalMessage {
  return {
    id,
    relationshipId,
    participant: "ME",
    type: "TEXT",
    body,
    createdAt: Date.now(),
    isActive: true,
    syncState: "PENDING",
    orderIndex,
    mediaReference: null,
  };
}

function createSynchronizedFetch(): typeof fetch {
  let completedPushes = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  return (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const response = await exports.default.fetch(input, init);

    if (new URL(url).pathname === "/v1/sync/push") {
      completedPushes += 1;
      if (!response.ok || completedPushes >= 2) release();
      await barrier;
    }

    return response;
  }) as typeof fetch;
}

function createClient(credential: string, fetchImpl: typeof fetch): CloudClient {
  return new CloudClient({
    baseUrl: "https://rucola.test",
    credential,
    fetchImpl,
  });
}

function createDeviceHarness(
  relationshipId: string,
  credential: string,
  initialMessages: LocalMessage[],
  fetchImpl: typeof fetch,
) {
  const messages = [...initialMessages];
  const outbox: OutboxItem[] = initialMessages.map((item, index) => ({
    messageId: item.id,
    senderSeq: index + 1,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    ciphertext: null,
    encryptionVersion: null,
    createdAt: item.createdAt,
  }));
  let cursor = 0;

  const state = {
    reconcileOutbox: async () => 0,
    getPendingOutbox: async () => outbox.filter((item) => item.nextAttemptAt <= Date.now()),
    storeOutboundCiphertext: async (id: string, ciphertext: string, encryptionVersion: number) => {
      const item = outbox.find((candidate) => candidate.messageId === id);
      if (!item) throw new Error(`Missing outbox item ${id}`);
      if (item.ciphertext !== null && (item.ciphertext !== ciphertext || item.encryptionVersion !== encryptionVersion)) {
        throw new Error(`Conflicting ciphertext for ${id}`);
      }
      item.ciphertext = ciphertext;
      item.encryptionVersion = encryptionVersion;
    },
    markSynced: async (id: string) => {
      const local = messages.find((item) => item.id === id);
      if (local) local.syncState = "SYNCED";
      const index = outbox.findIndex((item) => item.messageId === id);
      if (index >= 0) outbox.splice(index, 1);
    },
    markAttemptFailed: async (id: string, error: Error, now = Date.now()) => {
      const item = outbox.find((candidate) => candidate.messageId === id);
      if (!item) return;
      item.attempts += 1;
      item.lastError = error.message;
      item.nextAttemptAt = now;
    },
    markBlocked: async (id: string, error: Error) => {
      const index = outbox.findIndex((item) => item.messageId === id);
      if (index >= 0) outbox.splice(index, 1);
      const local = messages.find((item) => item.id === id);
      if (local) local.syncState = "SYNCED";
      throw new Error(`Unexpected blocked message ${id}: ${error.message}`);
    },
    getPullCursor: async () => cursor,
    commitInbound: async (
      batch: Array<{
        id: string;
        type: "TEXT" | "EMOJI";
        body: string;
        createdAt: number;
        serverSeq: number;
        mediaReference?: string | null;
      }>,
      nextCursor: number,
    ) => {
      for (const item of batch) {
        if (!messages.some((local) => local.id === item.id)) {
          messages.push({
            id: item.id,
            relationshipId,
            participant: "PARTNER",
            type: item.type,
            body: item.body,
            createdAt: item.createdAt,
            isActive: true,
            syncState: "SYNCED",
            orderIndex: messages.length + 1,
            mediaReference: item.mediaReference ?? null,
          });
        }
      }
      cursor = nextCursor;
    },
  };

  const repository = {
    getMessages: async () => messages,
  };

  const codec = {
    encryptionVersion: 1,
    encrypt: async (local: LocalMessage) => `cipher:${local.body}`,
    decrypt: async (remote: CloudPulledMessage) => ({
      type: remote.type,
      body: remote.ciphertext.replace(/^cipher:/, ""),
      mediaReference: null,
    }),
  };

  return {
    messages,
    outbox,
    get cursor() {
      return cursor;
    },
    engine: new SyncEngine({
      cloud: createClient(credential, fetchImpl),
      state,
      repository,
      codec,
    }),
  };
}

describe("mobile SyncEngine ↔ Cloud Worker integration", () => {
  it("syncs two devices through the real CloudClient and Worker with a pre-existing outbox backlog and synchronized concurrent sends", async () => {
    const { relationshipId, meCredential, partnerCredential } = await pair();

    const meMessage = message(relationshipId, "me-offline-1", "hello from me", 1);
    const partnerMessage = message(
      relationshipId,
      "partner-offline-1",
      "hello from partner",
      1,
    );
    const synchronizedFetch = createSynchronizedFetch();
    const me = createDeviceHarness(
      relationshipId,
      meCredential,
      [meMessage],
      synchronizedFetch,
    );
    const partner = createDeviceHarness(
      relationshipId,
      partnerCredential,
      [partnerMessage],
      synchronizedFetch,
    );

    const result = await Promise.all([me.engine.run(), partner.engine.run()]);

    expect(result.map((run) => run.failed)).toEqual([0, 0]);
    expect(result.map((run) => run.pushed)).toEqual([1, 1]);
    expect(me.messages.find((item) => item.id === "partner-offline-1")?.body).toBe(
      "hello from partner",
    );
    expect(partner.messages.find((item) => item.id === "me-offline-1")?.body).toBe(
      "hello from me",
    );
    const receiptRows = await env.DB
      .prepare(
        "SELECT message_id, server_seq FROM message_receipts WHERE relationship_id = ?1 ORDER BY server_seq",
      )
      .bind(relationshipId)
      .all<{ message_id: string; server_seq: number }>();
    const serverSeqByMessage = new Map(
      receiptRows.results.map((row) => [row.message_id, row.server_seq]),
    );
    expect(me.cursor).toBe(serverSeqByMessage.get("partner-offline-1"));
    expect(partner.cursor).toBe(serverSeqByMessage.get("me-offline-1"));

    // The receiver's cursor is intentionally scoped to peer messages. Prove that
    // a later peer message is still delivered even when that cursor is below the
    // global server sequence because the receiver never saw its own message.
    const thirdMessage = message(relationshipId, "me-offline-2", "a later hello", 2);
    me.messages.push(thirdMessage);
    me.outbox.push({
      messageId: thirdMessage.id,
      senderSeq: 2,
      attempts: 0,
      lastError: null,
      nextAttemptAt: 0,
      ciphertext: null,
      encryptionVersion: null,
      createdAt: thirdMessage.createdAt,
    });

    const thirdPush = await me.engine.run();
    expect(thirdPush.failed).toBe(0);
    expect(thirdPush.pushed).toBe(1);

    const thirdReceipt = await env.DB
      .prepare(
        "SELECT server_seq FROM message_receipts WHERE relationship_id = ?1 AND message_id = ?2",
      )
      .bind(relationshipId, thirdMessage.id)
      .first<{ server_seq: number }>();
    const thirdServerSeq = thirdReceipt?.server_seq;
    const cursorBeforeSecondSync = partner.cursor;
    expect(thirdServerSeq).toBeDefined();
    expect(thirdServerSeq!).toBeGreaterThan(cursorBeforeSecondSync);

    const secondPartnerSync = await partner.engine.run();
    expect(secondPartnerSync.failed).toBe(0);
    expect(secondPartnerSync.pulled).toBe(1);
    expect(partner.messages.find((item) => item.id === thirdMessage.id)?.body).toBe(
      "a later hello",
    );
    expect(partner.cursor).toBe(thirdServerSeq);

    const mailbox = await env.DB
      .prepare(
        "SELECT message_id, server_seq FROM mailbox_messages WHERE relationship_id = ?1 ORDER BY server_seq",
      )
      .bind(relationshipId)
      .all<{ message_id: string; server_seq: number }>();
    expect(mailbox.results).toEqual([]);

    const receipts = await env.DB
      .prepare(
        "SELECT message_id, acknowledged_at FROM message_receipts WHERE relationship_id = ?1 ORDER BY server_seq",
      )
      .bind(relationshipId)
      .all<{ message_id: string; acknowledged_at: number | null }>();
    expect(receipts.results).toHaveLength(3);
    expect(receipts.results.every((row) => row.acknowledged_at !== null)).toBe(true);
  });
});
