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
  createdAt: number;
};

function pairingRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({ expiresInSeconds: 3600 }),
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
      confirmationCode: invitation.confirmationCode,
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

function createClient(credential: string): CloudClient {
  return new CloudClient({
    baseUrl: "https://rucola.test",
    credential,
    fetchImpl: ((input, init) => exports.default.fetch(input, init)) as typeof fetch,
  });
}

function createDeviceHarness(
  relationshipId: string,
  credential: string,
  initialMessages: LocalMessage[],
) {
  const messages = [...initialMessages];
  const outbox: OutboxItem[] = initialMessages.map((item, index) => ({
    messageId: item.id,
    senderSeq: index + 1,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    createdAt: item.createdAt,
  }));
  let cursor = 0;

  const state = {
    reconcileOutbox: async () => 0,
    getPendingOutbox: async () => outbox.filter((item) => item.nextAttemptAt <= Date.now()),
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
      cloud: createClient(credential),
      state,
      repository,
      codec,
    }),
  };
}

describe("mobile SyncEngine ↔ Cloud Worker integration", () => {
  it("syncs two devices through the real CloudClient and Worker, including offline backlog and simultaneous sends", async () => {
    const { relationshipId, meCredential, partnerCredential } = await pair();

    const meMessage = message(relationshipId, "me-offline-1", "hello from me", 1);
    const partnerMessage = message(
      relationshipId,
      "partner-offline-1",
      "hello from partner",
      1,
    );
    const me = createDeviceHarness(relationshipId, meCredential, [meMessage]);
    const partner = createDeviceHarness(relationshipId, partnerCredential, [partnerMessage]);

    const result = await Promise.all([me.engine.run(), partner.engine.run()]);

    expect(result.map((run) => run.failed)).toEqual([0, 0]);
    expect(result.map((run) => run.pushed)).toEqual([1, 1]);
    expect(me.messages.find((item) => item.id === "partner-offline-1")?.body).toBe(
      "hello from partner",
    );
    expect(partner.messages.find((item) => item.id === "me-offline-1")?.body).toBe(
      "hello from me",
    );
    expect(me.cursor).toBe(2);
    expect(partner.cursor).toBe(2);

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
    expect(receipts.results).toHaveLength(2);
    expect(receipts.results.every((row) => row.acknowledged_at !== null)).toBe(true);
  });
});
