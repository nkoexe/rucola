import type { Message } from '../domain/models';
import type { RucolaRepository } from '../domain/repository';
import { CloudClient, CloudClientError } from '../cloud/CloudClient';
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
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Sync batch size must be between 1 and 100.');
  return batchSize;
}

function toCloudType(type: Message['type']): CloudMessageType { return type; }
function isSupportedWithoutMedia(type: Message['type']): boolean { return type === 'TEXT' || type === 'EMOJI'; }

function isRetryableSyncError(cause: unknown): boolean {
  if (!(cause instanceof CloudClientError)) return false;
  return cause.status === 0 || cause.status === 408 || cause.status === 429 || cause.status >= 500;
}

function isBlockedSyncError(cause: unknown): boolean {
  return cause instanceof Error && cause.message === 'Media synchronization is not implemented yet.';
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
    if (!Number.isSafeInteger(this.codec.encryptionVersion) || this.codec.encryptionVersion < 1 || this.codec.encryptionVersion > 255) throw new Error('Sync codec encryptionVersion must be between 1 and 255.');
  }

  run(): Promise<SyncRunResult> {
    if (!this.runPromise) {
      this.runPromise = this.runInternal().finally(() => { this.runPromise = null; });
    }
    return this.runPromise;
  }

  private async runInternal(): Promise<SyncRunResult> {
    const result: SyncRunResult = { pushed: 0, pulled: 0, acknowledged: 0, failed: 0, moreIncoming: false };
    await this.pushDue(result);
    await this.pullIncoming(result);
    return result;
  }

  private async pushDue(result: SyncRunResult): Promise<void> {
    await this.state.reconcileOutbox(this.now());
    const due = await this.state.getDueOutbox(this.now(), this.outboxBatchSize);
    if (due.length === 0) return;

    const messages = await this.repository.getMessages();
    const byId = new Map(messages.map((message) => [message.id, message]));

    for (const item of due) {
      try {
        const message = byId.get(item.messageId);
        if (!message) throw new Error('Local message no longer exists.');
        if (message.participant !== 'ME') throw new Error('Only local messages can be synchronized.');
        if (!isSupportedWithoutMedia(message.type)) throw new Error('Media synchronization is not implemented yet.');

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
        if (isBlockedSyncError(cause)) {
          await this.state.markBlocked(item.messageId, cause);
          result.failed += 1;
          // A blocked media message must not hold the entire text queue hostage.
          // It remains in the durable outbox, but its next attempt is intentionally
          // parked until media synchronization is implemented.
          continue;
        }

        if (isRetryableSyncError(cause)) {
          await this.state.markAttemptFailed(item.messageId, cause, this.now());
          result.failed += 1;
          // Preserve senderSeq ordering across transient failures.
          break;
        }

        await this.state.markBlocked(item.messageId, cause);
        result.failed += 1;
        // Permanent protocol/local failures cannot safely be retried automatically.
        // Do not block later independent messages behind them.
        continue;
      }
    }
  }

  private async pullIncoming(result: SyncRunResult): Promise<void> {
    let cursor = await this.state.getPullCursor();
    let hasMore = true;

    while (hasMore) {
      const response = await this.cloud.pullMessages(cursor, this.pullBatchSize);
      if (!Number.isSafeInteger(response.nextCursor) || response.nextCursor < cursor) throw new Error('Cloud returned an invalid pull cursor.');
      if (response.messages.length === 0) {
        if (response.nextCursor !== cursor) throw new Error('Cloud advanced the cursor without returning messages.');
        if (response.hasMore) throw new Error('Cloud reported more inbound messages without returning a batch.');
        result.moreIncoming = false;
        return;
      }

      const inbound: InboundSyncMessage[] = [];
      let previousServerSeq = cursor;
      for (const remote of response.messages) {
        if (!Number.isSafeInteger(remote.serverSeq) || remote.serverSeq <= previousServerSeq) throw new Error('Cloud returned inbound messages out of server-sequence order.');
        if (remote.senderParticipant !== 'PARTNER' || remote.senderDeviceId.trim() === '') throw new Error('Cloud returned a message from an invalid sender.');
        previousServerSeq = remote.serverSeq;
        const decoded = await this.codec.decrypt(remote);
        if (decoded.type !== remote.type) throw new Error('Sync codec changed the inbound message type.');
        inbound.push({ id: remote.messageId, type: decoded.type, body: decoded.body, createdAt: remote.createdAt, serverSeq: remote.serverSeq, mediaReference: decoded.mediaReference });
      }

      const lastServerSeq = inbound.at(-1)?.serverSeq ?? cursor;
      if (response.nextCursor < lastServerSeq) throw new Error('Cloud cursor precedes its newest inbound message.');

      await this.state.commitInbound(inbound, response.nextCursor, this.now());
      const ack = await this.cloud.acknowledgeMessages(response.nextCursor);
      if (ack.acknowledgedThrough < response.nextCursor) throw new Error('Cloud acknowledged fewer messages than requested.');

      cursor = response.nextCursor;
      result.pulled += inbound.length;
      result.acknowledged += ack.deleted;
      hasMore = response.hasMore;
      result.moreIncoming = hasMore;
    }
  }
}
