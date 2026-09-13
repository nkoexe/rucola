import type { Message } from '../domain/models';
import type { RucolaRepository } from '../domain/repository';
import { CloudClient } from '../cloud/CloudClient';
import type { CloudPulledMessage, CloudMessageType } from '../cloud/protocol';
import { SQLiteSyncStateStore, type InboundSyncMessage } from '../data/SQLiteSyncStateStore';

export interface SyncCodec {
  encryptionVersion: number;
  encrypt(message: Message): Promise<string>;
  decrypt(message: CloudPulledMessage): Promise<{
    type: CloudMessageType;
    body: string;
    mediaReference?: string | null;
  }>;
}

export interface SyncEngineOptions {
  cloud: CloudClient;
  state: SQLiteSyncStateStore;
  repository: RucolaRepository;
  codec: SyncCodec;
  now?: () => number;
  outboxBatchSize?: number;
  pullBatchSize?: number;
}

export interface SyncRunResult {
  pushed: number;
  pulled: number;
  acknowledged: number;
  failed: number;
  moreIncoming: boolean;
}

const DEFAULT_OUTBOX_BATCH_SIZE = 20;
const DEFAULT_PULL_BATCH_SIZE = 50;

function normalizeBatchSize(value: number | undefined, fallback: number): number {
  const batchSize = value ?? fallback;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Sync batch size must be between 1 and 100.');
  }
  return batchSize;
}

function toCloudType(type: Message['type']): CloudMessageType {
  return type;
}

function isSupportedWithoutMedia(type: Message['type']): boolean {
  return type === 'TEXT' || type === 'EMOJI';
}

export class SyncEngine {
  private readonly cloud: CloudClient;
  private readonly state: SQLiteSyncStateStore;
  private readonly repository: RucolaRepository;
  private readonly codec: SyncCodec;
  private readonly now: () => number;
  private readonly outboxBatchSize: number;
  private readonly pullBatchSize: number;
  private runPromise: Promise<SyncRunResult> | null = null;

  constructor(options: SyncEngineOptions) {
    this.cloud = options.cloud;
    this.state = options.state;
    this.repository = options.repository;
    this.codec = options.codec;
    this.now = options.now ?? Date.now;
    this.outboxBatchSize = normalizeBatchSize(options.outboxBatchSize, DEFAULT_OUTBOX_BATCH_SIZE);
    this.pullBatchSize = normalizeBatchSize(options.pullBatchSize, DEFAULT_PULL_BATCH_SIZE);

    if (!Number.isSafeInteger(this.codec.encryptionVersion) || this.codec.encryptionVersion < 1 || this.codec.encryptionVersion > 255) {
      throw new Error('Sync codec encryptionVersion must be between 1 and 255.');
    }
  }

  /** Coalesces concurrent callers into one sync pass. */
  run(): Promise<SyncRunResult> {
    if (!this.runPromise) {
      this.runPromise = this.runInternal().finally(() => {
        this.runPromise = null;
      });
    }
    return this.runPromise;
  }

  private async runInternal(): Promise<SyncRunResult> {
    const result: SyncRunResult = {
      pushed: 0,
      pulled: 0,
      acknowledged: 0,
      failed: 0,
      moreIncoming: false,
    };

    await this.pushDue(result);
    await this.pullIncoming(result);
    return result;
  }

  private async pushDue(result: SyncRunResult): Promise<void> {
    const due = await this.state.getDueOutbox(this.now(), this.outboxBatchSize);

    for (const item of due) {
      try {
        const message = (await this.repository.getMessages()).find((candidate) => candidate.id === item.messageId);
        if (!message) {
          await this.state.markAttemptFailed(item.messageId, new Error('Local message no longer exists.'), this.now());
          result.failed += 1;
          continue;
        }

        if (message.participant !== 'ME') {
          await this.state.markAttemptFailed(item.messageId, new Error('Only local messages can be synchronized.'), this.now());
          result.failed += 1;
          continue;
        }

        if (!isSupportedWithoutMedia(message.type)) {
          await this.state.markAttemptFailed(item.messageId, new Error('Media synchronization is not implemented yet.'), this.now());
          result.failed += 1;
          continue;
        }

        const ciphertext = await this.codec.encrypt(message);
        if (!ciphertext) throw new Error('Sync codec returned empty ciphertext.');

        await this.cloud.pushMessage({
          messageId: message.id,
          senderSeq: item.senderSeq,
          type: toCloudType(message.type),
          ciphertext,
          encryptionVersion: this.codec.encryptionVersion,
          createdAt: message.createdAt,
        });
        await this.state.markSynced(message.id);
        result.pushed += 1;
      } catch (cause) {
        await this.state.markAttemptFailed(item.messageId, cause, this.now());
        result.failed += 1;
      }
    }
  }

  private async pullIncoming(result: SyncRunResult): Promise<void> {
    let cursor = await this.state.getPullCursor();
    let hasMore = true;

    while (hasMore) {
      const response = await this.cloud.pullMessages(cursor, this.pullBatchSize);
      if (response.messages.length === 0) {
        if (response.nextCursor < cursor) throw new Error('Cloud returned a backwards pull cursor.');
        if (response.nextCursor !== cursor) throw new Error('Cloud advanced the cursor without returning messages.');
        result.moreIncoming = false;
        return;
      }

      if (!Number.isSafeInteger(response.nextCursor) || response.nextCursor < cursor) {
        throw new Error('Cloud returned an invalid pull cursor.');
      }

      const inbound: InboundSyncMessage[] = [];
      for (const remote of response.messages) {
        const decoded = await this.codec.decrypt(remote);
        inbound.push({
          id: remote.messageId,
          type: decoded.type,
          body: decoded.body,
          createdAt: remote.createdAt,
          serverSeq: remote.serverSeq,
          mediaReference: decoded.mediaReference,
        });
      }

      await this.state.commitInbound(inbound, response.nextCursor, this.now());

      const ack = await this.cloud.acknowledgeMessages(response.nextCursor);
      if (ack.acknowledgedThrough < response.nextCursor) {
        throw new Error('Cloud acknowledged fewer messages than requested.');
      }

      cursor = response.nextCursor;
      result.pulled += inbound.length;
      result.acknowledged += ack.deleted;
      hasMore = response.hasMore;
      result.moreIncoming = hasMore;
    }
  }
}
