import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudClient, CloudClientError } from '../CloudClient.ts';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('authenticated requests send the device credential', async () => {
  const requests = [];
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test/',
    credential: 'test-credential',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ authenticated: true, participant: 'ME', relationshipStatus: 'ACTIVE' });
    },
  });
  const result = await client.authProbe();
  assert.deepEqual(result, { authenticated: true, participant: 'ME' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://cloud.example.test/v1/auth/probe');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-credential');
  assert.equal(requests[0].init.method, 'GET');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('pairing bootstrap is intentionally unauthenticated and returns credentials', async () => {
  let captured;
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        relationshipId: 'relationship', invitationId: 'invitation', deviceId: 'device', participant: 'ME',
        credential: 'credential', token: 'token', confirmationCode: '😀😃😄😁😆', relationshipKeyCommitment: 'a'.repeat(64), expiresAt: 123,
      }, 201);
    },
  });
  const result = await client.bootstrapPairing({ expiresInSeconds: 60, relationshipKeyCommitment: 'a'.repeat(64) });
  assert.equal(result.credential, 'credential');
  assert.equal(captured.url, 'https://cloud.example.test/v1/pairing/bootstrap');
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(captured.init.body), { expiresInSeconds: 60 });
});

test('pull encodes the durable cursor and limit', async () => {
  let capturedUrl;
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test',
    credential: 'credential',
    fetchImpl: async (url) => {
      capturedUrl = url;
      return jsonResponse({ messages: [], nextCursor: 41, hasMore: false });
    },
  });
  const result = await client.pullMessages(41, 50);
  assert.deepEqual(result, { messages: [], nextCursor: 41, hasMore: false });
  assert.equal(capturedUrl, 'https://cloud.example.test/v1/sync/pull?after=41&limit=50');
});

test('server protocol errors become typed CloudClientError values', async () => {
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test', credential: 'credential',
    fetchImpl: async () => jsonResponse({ error: { code: 'ACK_CURSOR_AHEAD', message: 'too far' } }, 409),
  });
  await assert.rejects(() => client.acknowledgeMessages(99), (error) => {
    assert(error instanceof CloudClientError);
    assert.equal(error.code, 'ACK_CURSOR_AHEAD');
    assert.equal(error.status, 409);
    assert.equal(error.message, 'too far');
    return true;
  });
});

test('parses the worker health response', async () => {
  const client = new CloudClient({ baseUrl: 'https://cloud.example.test', fetchImpl: async () => new Response(JSON.stringify({ ok: true, service: 'rucola-cloud-dev', version: 'sync-hardening-1', database: true }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  await assert.deepEqual(await client.health(), { ok: true, service: 'rucola-cloud-dev', version: 'sync-hardening-1', database: true });
});

test('authenticated operations fail locally when no credential exists', async () => {
  const client = new CloudClient({ baseUrl: 'https://cloud.example.test', fetchImpl: async () => { throw new Error('network should not be reached'); } });
  await assert.rejects(() => client.pullMessages(), (error) => error instanceof CloudClientError && error.code === 'CLIENT_UNAUTHENTICATED' && error.status === 0);
});

test('media upload uses the reserved MIME and exact content length', async () => {
  let captured;
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test', credential: 'credential',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({ uploadId: 'upload', status: 'UPLOADED' });
    },
  });
  const result = await client.uploadMedia('upload/id', new Uint8Array([1, 2, 3]), 'image/jpeg', 3);
  assert.deepEqual(result, { uploadId: 'upload', status: 'UPLOADED' });
  assert.equal(captured.url, 'https://cloud.example.test/v1/media/upload%2Fid');
  assert.equal(captured.init.headers.Authorization, 'Bearer credential');
  assert.equal(captured.init.headers['Content-Type'], 'image/jpeg');
  assert.equal(captured.init.headers['Content-Length'], '3');
});

test('malformed successful JSON is rejected instead of being blindly cast', async () => {
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test', credential: 'credential',
    fetchImpl: async () => jsonResponse({ messages: 'not-an-array', nextCursor: 4, hasMore: false }),
  });
  await assert.rejects(() => client.pullMessages(), (error) => error instanceof CloudClientError && error.code === 'INVALID_RESPONSE');
});

test('rejects sync push responses with invalid zero sequence fields', async () => {
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test',
    credential: 'credential',
    fetchImpl: async () => jsonResponse({
      messageId: 'message',
      senderSeq: 0,
      serverSeq: 0,
      acceptedAt: 0,
    }),
  });
  await assert.rejects(
    () => client.pushMessage({
      messageId: 'message',
      senderSeq: 1,
      type: 'TEXT',
      ciphertext: 'cipher',
      encryptionVersion: 1,
      createdAt: 1_700_000_000_000,
    }),
    (error) => error instanceof CloudClientError && error.code === 'INVALID_RESPONSE',
  );
});

test('transport failures become retryable typed network errors', async () => {
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test',
    credential: 'credential',
    fetchImpl: async () => {
      throw new TypeError('network unavailable');
    },
  });
  await assert.rejects(() => client.pullMessages(), (error) => {
    assert(error instanceof CloudClientError);
    assert.equal(error.code, 'CLIENT_NETWORK_ERROR');
    assert.equal(error.status, 0);
    assert.equal(error.message, 'network unavailable');
    return true;
  });
});

test('a stalled request is converted into a typed timeout error', async () => {
  const client = new CloudClient({
    baseUrl: 'https://cloud.example.test', credential: 'credential', requestTimeoutMs: 5,
    fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });
  await assert.rejects(() => client.pullMessages(), (error) => error instanceof CloudClientError && error.code === 'CLIENT_TIMEOUT' && error.status === 0);
});
