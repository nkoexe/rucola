import type {
  AuthProbeResponse,
  CloudAckResponse,
  CloudPullResponse,
  CloudPushMessage,
  CloudPushResponse,
  CompleteMediaResponse,
  CreateMediaReservationRequest,
  CreateMediaReservationResponse,
  MediaUploadResponse,
  PairingAcceptResponse,
  PairingBootstrapRequest,
  PairingBootstrapResponse,
  PairingCreateResponse,
} from './protocol';

export type CloudFetch = typeof fetch;

export interface CloudClientOptions {
  baseUrl: string;
  credential?: string | null;
  fetchImpl?: CloudFetch;
}

export interface CloudClientErrorDetails {
  code: string;
  message: string;
  status: number;
}

export class CloudClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(details: CloudClientErrorDetails) {
    super(details.message);
    this.name = 'CloudClientError';
    this.code = details.code;
    this.status = details.status;
  }
}

type JsonValue = unknown;

type RequestOptions = {
  method: 'GET' | 'POST';
  path: string;
  body?: JsonValue;
  authenticated?: boolean;
};

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Cloud base URL is required.');
  return trimmed.replace(/\/+$/, '');
}

function contentTypeIsJson(response: Response): boolean {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function parseResponseBody(response: Response): Promise<JsonValue> {
  if (!contentTypeIsJson(response)) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseError(status: number, body: JsonValue): CloudClientError {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as { code?: unknown }).code;
      const message = (error as { message?: unknown }).message;
      if (typeof code === 'string' && typeof message === 'string') {
        return new CloudClientError({ code, message, status });
      }
    }
  }

  return new CloudClientError({
    code: `HTTP_${status}`,
    message: `Cloud request failed with HTTP ${status}.`,
    status,
  });
}

export class CloudClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: CloudFetch;
  private credential: string | null;

  constructor(options: CloudClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credential = options.credential?.trim() || null;
  }

  setCredential(credential: string | null): void {
    this.credential = credential?.trim() || null;
  }

  clearCredential(): void {
    this.credential = null;
  }

  hasCredential(): boolean {
    return this.credential !== null;
  }

  async authProbe(): Promise<AuthProbeResponse> {
    return this.request<AuthProbeResponse>({
      method: 'GET',
      path: '/v1/auth/probe',
      authenticated: true,
    });
  }

  async bootstrapPairing(request: PairingBootstrapRequest = {}): Promise<PairingBootstrapResponse> {
    return this.request<PairingBootstrapResponse>({
      method: 'POST',
      path: '/v1/pairing/bootstrap',
      body: request,
    });
  }

  async createInvitation(expiresInSeconds?: number): Promise<PairingCreateResponse> {
    return this.request<PairingCreateResponse>({
      method: 'POST',
      path: '/v1/pairing/create',
      body: expiresInSeconds === undefined ? {} : { expiresInSeconds },
      authenticated: true,
    });
  }

  async acceptInvitation(token: string, confirmationCode: string): Promise<PairingAcceptResponse> {
    return this.request<PairingAcceptResponse>({
      method: 'POST',
      path: '/v1/pairing/accept',
      body: { token, confirmationCode },
    });
  }

  async pushMessage(message: CloudPushMessage): Promise<CloudPushResponse> {
    return this.request<CloudPushResponse>({
      method: 'POST',
      path: '/v1/sync/push',
      body: message,
      authenticated: true,
    });
  }

  async pullMessages(after = 0, limit = 50): Promise<CloudPullResponse> {
    const params = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.request<CloudPullResponse>({
      method: 'GET',
      path: `/v1/sync/pull?${params.toString()}`,
      authenticated: true,
    });
  }

  async acknowledgeMessages(throughServerSeq: number): Promise<CloudAckResponse> {
    return this.request<CloudAckResponse>({
      method: 'POST',
      path: '/v1/sync/ack',
      body: { throughServerSeq },
      authenticated: true,
    });
  }

  async createMediaReservation(request: CreateMediaReservationRequest): Promise<CreateMediaReservationResponse> {
    return this.request<CreateMediaReservationResponse>({
      method: 'POST',
      path: '/v1/media/create',
      body: request,
      authenticated: true,
    });
  }

  async uploadMedia(
    uploadId: string,
    body: BodyInit,
    contentType: string,
    contentLength: number,
  ): Promise<MediaUploadResponse> {
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new Error('A positive safe media content length is required.');
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1/media/${encodeURIComponent(uploadId)}`, {
      method: 'PUT',
      headers: {
        Authorization: this.authorizationHeader(),
        'Content-Type': contentType,
        'Content-Length': String(contentLength),
      },
      body,
    });
    return this.parseSuccessfulResponse<MediaUploadResponse>(response);
  }

  async completeMedia(uploadId: string): Promise<CompleteMediaResponse> {
    return this.request<CompleteMediaResponse>({
      method: 'POST',
      path: `/v1/media/${encodeURIComponent(uploadId)}/complete`,
      authenticated: true,
    });
  }

  private authorizationHeader(): string {
    if (!this.credential) throw new CloudClientError({
      code: 'CLIENT_UNAUTHENTICATED',
      message: 'A cloud device credential is required for this operation.',
      status: 0,
    });
    return `Bearer ${this.credential}`;
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.authenticated) headers.Authorization = this.authorizationHeader();

    const response = await this.fetchImpl(`${this.baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return this.parseSuccessfulResponse<T>(response);
  }

  private async parseSuccessfulResponse<T>(response: Response): Promise<T> {
    const body = await parseResponseBody(response);
    if (!response.ok) throw parseError(response.status, body);
    if (body === null) {
      throw new CloudClientError({
        code: 'INVALID_RESPONSE',
        message: 'Cloud returned a non-JSON success response.',
        status: response.status,
      });
    }
    return body as T;
  }
}
