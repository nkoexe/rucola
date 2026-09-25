import type { AuthProbeResponse, CloudAckResponse, CloudPullResponse, CloudPushMessage, CloudPushResponse, CompleteMediaResponse, CreateMediaReservationRequest, CreateMediaReservationResponse, MediaUploadResponse, PairingAcceptResponse, PairingBootstrapRequest, PairingBootstrapResponse, PairingCreateResponse, PairingSessionCompleteResponse, PairingSessionJoinResponse, PairingSessionMutationResponse, PairingSessionPollResponse, PairingSessionRequest, PairingSessionStartResponse } from './protocol';
import { isValidPairingConfirmationCode } from './pairingCode.ts';

export type CloudFetch = typeof fetch;
export interface CloudHealthResponse { ok: boolean; service: string; version: string; database: boolean; }
export interface CloudClientOptions { baseUrl: string; credential?: string | null; fetchImpl?: CloudFetch; requestTimeoutMs?: number; uploadTimeoutMs?: number; }
export interface CloudClientErrorDetails { code: string; message: string; status: number; }
export class CloudClientError extends Error { readonly code: string; readonly status: number; constructor(details: CloudClientErrorDetails) { super(details.message); this.name = 'CloudClientError'; this.code = details.code; this.status = details.status; } }
type JsonValue = unknown;
type RequestOptions = { method: 'GET' | 'POST'; path: string; body?: JsonValue; authenticated?: boolean; timeoutMs?: number; validator?: (body: unknown) => void; };
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_ENCRYPTION_VERSION = 255;
function normalizeBaseUrl(value: string): string { const trimmed = value.trim(); if (!trimmed) throw new Error('Cloud base URL is required.'); return trimmed.replace(/\/+$/, ''); }
function normalizeTimeout(value: number | undefined, fallback: number, label: string): number { const timeout = value ?? fallback; if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS) throw new Error(`${label} must be between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`); return timeout; }
function contentTypeIsJson(response: Response): boolean { return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'; }
async function parseResponseBody(response: Response): Promise<JsonValue> { if (!contentTypeIsJson(response)) return null; try { return await response.json(); } catch { return null; } }
function parseError(status: number, body: JsonValue): CloudClientError { if (body && typeof body === 'object' && !Array.isArray(body)) { const error = (body as { error?: unknown }).error; if (error && typeof error === 'object' && !Array.isArray(error)) { const code = (error as { code?: unknown }).code; const message = (error as { message?: unknown }).message; if (typeof code === 'string' && typeof message === 'string') return new CloudClientError({ code, message, status }); } } return new CloudClientError({ code: `HTTP_${status}`, message: `Cloud request failed with HTTP ${status}.`, status }); }
function invalidResponse(message: string): never { throw new CloudClientError({ code: 'INVALID_RESPONSE', message, status: 200 }); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isSafeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isSafePositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function isSafeNonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isEncryptionVersion(value: unknown): value is number { return isSafePositiveInteger(value) && (value as number) <= MAX_ENCRYPTION_VERSION; }
function isSha256Hex(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function isBase64Bytes(value: unknown, expectedBytes: number): value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false; try { return atob(value).length === expectedBytes; } catch { return false; } }
function assertPairingSessionStart(body: unknown): asserts body is PairingSessionStartResponse { if (!isRecord(body) || !isString(body.sessionId) || !isBase64Bytes(body.sessionId, 16) || !isSafePositiveInteger(body.expiresAt) || !isSha256Hex(body.relationshipKeyCommitment)) invalidResponse('Cloud returned an invalid pairing session start response.'); }
function assertPairingSessionJoin(body: unknown): asserts body is PairingSessionJoinResponse { if (!isRecord(body) || !isString(body.sessionId) || !isBase64Bytes(body.sessionId, 16) || !isString(body.invitationId) || !isSafeId(body.invitationId) || !isSafePositiveInteger(body.expiresAt) || !isBase64Bytes(body.initiatorShare, 32) || !isString(body.relationshipId) || !isSafeId(body.relationshipId) || !isSha256Hex(body.relationshipKeyCommitment)) invalidResponse('Cloud returned an invalid pairing session join response.'); }
function assertPairingSessionPoll(body: unknown): asserts body is PairingSessionPollResponse { if (!isRecord(body) || !isString(body.sessionId) || !isBase64Bytes(body.sessionId, 16) || !isString(body.relationshipId) || !isSafeId(body.relationshipId) || !isSafePositiveInteger(body.expiresAt) || !isBase64Bytes(body.initiatorShare, 32) || !(body.responderShare === null || isBase64Bytes(body.responderShare, 32)) || !(body.handoff === null || isString(body.handoff)) || !(body.confirmation === null || isString(body.confirmation)) || !(body.partnerCredentialHash === undefined || body.partnerCredentialHash === null || isSha256Hex(body.partnerCredentialHash)) || typeof body.completed !== 'boolean' || !isSha256Hex(body.relationshipKeyCommitment) || !(body.partnerDeviceId === undefined || body.partnerDeviceId === null || isSafeId(body.partnerDeviceId))) invalidResponse('Cloud returned an invalid pairing session poll response.'); }
function assertPairingSessionMutation(body: unknown): asserts body is PairingSessionMutationResponse { if (!isRecord(body) || body.ok !== true) invalidResponse('Cloud returned an invalid pairing session mutation response.'); }
function assertPairingSessionComplete(body: unknown): asserts body is PairingSessionCompleteResponse { if (!isRecord(body) || body.completed !== true || !isSafeId(body.relationshipId) || !isSafeId(body.partnerDeviceId)) invalidResponse('Cloud returned an invalid pairing session completion response.'); }

function isMessageType(value: unknown): boolean { return value === 'TEXT' || value === 'EMOJI' || value === 'PHOTO_VIDEO' || value === 'DRAWING'; }
function requirePullMessage(message: Record<string, unknown>): boolean { return isString(message.messageId) && isString(message.senderDeviceId) && (message.senderParticipant === 'ME' || message.senderParticipant === 'PARTNER') && isSafePositiveInteger(message.senderSeq) && isSafeNonNegativeInteger(message.createdAt) && isSafePositiveInteger(message.serverSeq) && isSafeNonNegativeInteger(message.receivedAt) && isMessageType(message.type) && isString(message.ciphertext) && isEncryptionVersion(message.encryptionVersion) && (message.mediaUploadId === null || isString(message.mediaUploadId)); }
function assertResponseShape(path: string, body: unknown): void {
  if (!isRecord(body)) invalidResponse(`Cloud returned an invalid response for ${path}.`);
  const requireStrings = (...keys: string[]) => keys.every((key) => isString(body[key]));
  if (path === '/health') { if (body.ok !== true || !isString(body.service) || !isString(body.version) || body.database !== true) invalidResponse('Cloud returned an invalid health response.'); return; }
  if (path === '/v1/auth/probe') { if (body.authenticated !== true || (body.participant !== 'ME' && body.participant !== 'PARTNER') || (body.relationshipStatus !== 'PAIRING' && body.relationshipStatus !== 'ACTIVE' && body.relationshipStatus !== 'ENDED')) invalidResponse('Cloud returned an invalid auth probe response.'); return; }
  if (path === '/v1/pairing/bootstrap') { if (!requireStrings('relationshipId', 'invitationId', 'deviceId', 'credential', 'token', 'confirmationCode', 'relationshipKeyCommitment') || body.participant !== 'ME' || !isSafePositiveInteger(body.expiresAt) || !isValidPairingConfirmationCode(String(body.confirmationCode)) || !isSha256Hex(body.relationshipKeyCommitment)) invalidResponse('Cloud returned an invalid pairing bootstrap response.'); return; }
  if (path === '/v1/pairing/create') { if (!requireStrings('relationshipId', 'invitationId', 'token', 'confirmationCode', 'relationshipKeyCommitment') || !isSafePositiveInteger(body.expiresAt) || !isValidPairingConfirmationCode(String(body.confirmationCode)) || !isSha256Hex(body.relationshipKeyCommitment)) invalidResponse('Cloud returned an invalid pairing creation response.'); return; }
  if (path === '/v1/pairing/accept') { if (!requireStrings('relationshipId', 'deviceId', 'credential', 'relationshipKeyCommitment') || body.participant !== 'PARTNER' || !isSha256Hex(body.relationshipKeyCommitment)) invalidResponse('Cloud returned an invalid pairing acceptance response.'); return; }
  if (path === '/v1/sync/push') {
    if (!requireStrings('messageId') || !isSafePositiveInteger(body.senderSeq) || !isSafePositiveInteger(body.serverSeq) || !isSafePositiveInteger(body.acceptedAt)) {
      invalidResponse('Cloud returned an invalid sync push response.');
    }
    return;
  }
  if (path === '/v1/sync/pull') { if (!Array.isArray(body.messages) || !isSafeNonNegativeInteger(body.nextCursor) || typeof body.hasMore !== 'boolean') invalidResponse('Cloud returned an invalid sync pull response.'); for (const message of body.messages) if (!isRecord(message) || !requirePullMessage(message)) invalidResponse('Cloud returned an invalid inbound sync message.'); return; }
  if (path === '/v1/sync/ack') { if (!isSafePositiveInteger(body.acknowledgedThrough) || !isSafeNonNegativeInteger(body.deleted) || !isSafePositiveInteger(body.acknowledgedAt)) invalidResponse('Cloud returned an invalid sync ACK response.'); return; }
  if (path === '/v1/media/create') { if (!requireStrings('uploadId', 'mediaType', 'mime') || (body.mediaType !== 'PHOTO' && body.mediaType !== 'VIDEO') || !isSafePositiveInteger(body.size) || !(body.checksum === null || typeof body.checksum === 'string') || body.status !== 'PENDING' || !isSafePositiveInteger(body.expiresAt)) invalidResponse('Cloud returned an invalid media reservation response.'); return; }
  if (path.endsWith('/complete')) { if (!requireStrings('uploadId') || body.status !== 'READY') invalidResponse('Cloud returned an invalid media completion response.'); return; }
  if (path.startsWith('/v1/media/') && path.split('/').length === 4) { if (!requireStrings('uploadId') || body.status !== 'UPLOADED') invalidResponse('Cloud returned an invalid media upload response.'); return; }
}

export class CloudClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: CloudFetch;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private credential: string | null;
  constructor(options: CloudClientOptions) { this.baseUrl = normalizeBaseUrl(options.baseUrl); this.fetchImpl = options.fetchImpl ?? fetch; this.requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'Cloud request timeout'); this.uploadTimeoutMs = normalizeTimeout(options.uploadTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS, 'Cloud upload timeout'); this.credential = options.credential?.trim() || null; }
  setCredential(credential: string | null): void { this.credential = credential?.trim() || null; }
  clearCredential(): void { this.credential = null; }
  hasCredential(): boolean { return this.credential !== null; }
  async health(): Promise<CloudHealthResponse> { return this.request<CloudHealthResponse>({ method: 'GET', path: '/health' }); }
  async authProbe(): Promise<AuthProbeResponse> { return this.request<AuthProbeResponse>({ method: 'GET', path: '/v1/auth/probe', authenticated: true }); }
  async bootstrapPairing(request: PairingBootstrapRequest): Promise<PairingBootstrapResponse> { return this.request<PairingBootstrapResponse>({ method: 'POST', path: '/v1/pairing/bootstrap', body: request }); }
  async createInvitation(expiresInSeconds?: number): Promise<PairingCreateResponse> { return this.request<PairingCreateResponse>({ method: 'POST', path: '/v1/pairing/create', body: expiresInSeconds === undefined ? {} : { expiresInSeconds }, authenticated: true }); }
  async acceptInvitation(token: string, confirmationCode: string, relationshipKeyCommitment: string): Promise<PairingAcceptResponse> { return this.request<PairingAcceptResponse>({ method: 'POST', path: '/v1/pairing/accept', body: { token, confirmationCode, relationshipKeyCommitment } }); }
  async startPairingSession(request: Omit<PairingSessionRequest, 'action'>): Promise<PairingSessionStartResponse> {
    return this.request<PairingSessionStartResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: { action: 'START', ...request },
      authenticated: true,
      validator: assertPairingSessionStart,
    });
  }
  async joinPairingSession(confirmationCode: string): Promise<PairingSessionJoinResponse> {
    return this.request<PairingSessionJoinResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: { action: 'JOIN', confirmationCode },
      validator: assertPairingSessionJoin,
    });
  }
  async publishPairingResponderShare(sessionId: string, confirmationCode: string, share: string): Promise<PairingSessionMutationResponse> {
    return this.request<PairingSessionMutationResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: { action: 'PUBLISH_RESPONDER_SHARE', sessionId, confirmationCode, share },
      validator: assertPairingSessionMutation,
    });
  }
  async publishPairingHandoff(sessionId: string, handoff: string): Promise<PairingSessionMutationResponse> {
    return this.request<PairingSessionMutationResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: { action: 'PUBLISH_HANDOFF', sessionId, handoff },
      authenticated: true,
      validator: assertPairingSessionMutation,
    });
  }
  async publishPairingConfirmation(sessionId: string, confirmationCode: string, confirmation: string, partnerCredentialHash: string, partnerDeviceId: string): Promise<PairingSessionMutationResponse> {
    return this.request<PairingSessionMutationResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: { action: 'PUBLISH_CONFIRMATION', sessionId, confirmationCode, confirmation, partnerCredentialHash, partnerDeviceId },
      validator: assertPairingSessionMutation,
    });
  }
  async completePairingSession(sessionId: string): Promise<PairingSessionCompleteResponse> {
    return this.request<PairingSessionCompleteResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: { action: 'COMPLETE', sessionId },
      authenticated: true,
      validator: assertPairingSessionComplete,
    });
  }
  async pollPairingSession(sessionId: string, confirmationCode?: string): Promise<PairingSessionPollResponse> {
    return this.request<PairingSessionPollResponse>({
      method: 'POST',
      path: '/v1/pairing/session',
      body: confirmationCode === undefined
        ? { action: 'POLL', sessionId }
        : { action: 'POLL', sessionId, confirmationCode },
      authenticated: confirmationCode === undefined,
      validator: assertPairingSessionPoll,
    });
  }
  async pushMessage(message: CloudPushMessage): Promise<CloudPushResponse> { return this.request<CloudPushResponse>({ method: 'POST', path: '/v1/sync/push', body: message, authenticated: true }); }
  async pullMessages(after = 0, limit = 50): Promise<CloudPullResponse> { const params = new URLSearchParams({ after: String(after), limit: String(limit) }); return this.request<CloudPullResponse>({ method: 'GET', path: `/v1/sync/pull?${params.toString()}`, authenticated: true }); }
  async acknowledgeMessages(throughServerSeq: number): Promise<CloudAckResponse> { return this.request<CloudAckResponse>({ method: 'POST', path: '/v1/sync/ack', body: { throughServerSeq }, authenticated: true }); }
  async createMediaReservation(request: CreateMediaReservationRequest): Promise<CreateMediaReservationResponse> { return this.request<CreateMediaReservationResponse>({ method: 'POST', path: '/v1/media/create', body: request, authenticated: true }); }
  async uploadMedia(uploadId: string, body: BodyInit, contentType: string, contentLength: number): Promise<MediaUploadResponse> { if (!Number.isSafeInteger(contentLength) || contentLength < 1) throw new Error('A positive safe media content length is required.'); const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/media/${encodeURIComponent(uploadId)}`, { method: 'PUT', headers: { Authorization: this.authorizationHeader(), 'Content-Type': contentType, 'Content-Length': String(contentLength) }, body }, this.uploadTimeoutMs); return this.parseSuccessfulResponse<MediaUploadResponse>(response, `/v1/media/${encodeURIComponent(uploadId)}`); }
  async completeMedia(uploadId: string): Promise<CompleteMediaResponse> { return this.request<CompleteMediaResponse>({ method: 'POST', path: `/v1/media/${encodeURIComponent(uploadId)}/complete`, authenticated: true }); }
  private authorizationHeader(): string { if (!this.credential) throw new CloudClientError({ code: 'CLIENT_UNAUTHENTICATED', message: 'A cloud device credential is required for this operation.', status: 0 }); return `Bearer ${this.credential}`; }
  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await this.fetchImpl(url, { ...init, signal: controller.signal }); } catch (cause) { if (controller.signal.aborted) throw new CloudClientError({ code: 'CLIENT_TIMEOUT', message: `Cloud request timed out after ${timeoutMs} ms.`, status: 0 }); const message = cause instanceof Error && cause.message ? cause.message : 'Cloud request failed before a response was received.'; throw new CloudClientError({ code: 'CLIENT_NETWORK_ERROR', message, status: 0 }); } finally { clearTimeout(timer); } }
  private async request<T>(options: RequestOptions): Promise<T> { const headers: Record<string, string> = { Accept: 'application/json' }; if (options.body !== undefined) headers['Content-Type'] = 'application/json'; if (options.authenticated) headers.Authorization = this.authorizationHeader(); const response = await this.fetchWithTimeout(`${this.baseUrl}${options.path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }, options.timeoutMs ?? this.requestTimeoutMs); return this.parseSuccessfulResponse<T>(response, options.path.split('?')[0] ?? options.path, options.validator); }
  private async parseSuccessfulResponse<T>(response: Response, path: string, validator?: (body: unknown) => void): Promise<T> { const body = await parseResponseBody(response); if (!response.ok) throw parseError(response.status, body); if (body === null) throw new CloudClientError({ code: 'INVALID_RESPONSE', message: 'Cloud returned a non-JSON success response.', status: response.status }); if (validator) validator(body); else assertResponseShape(path, body); return body as T; }
}
