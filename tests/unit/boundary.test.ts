import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providerTestRoute from '@/app/api/admin/providers/[id]/test/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { createApiKey, getApiKey } from '@/lib/apikeys';
import { open } from '@/lib/crypto';
import { queryAll, queryOne } from '@/lib/db';
import { insertRequestLog } from '@/lib/logs';
import { MAX_FAILURES, resetLoginThrottle } from '@/lib/login-throttle';
import { createProvider } from '@/lib/providers';
import { relay } from '@/lib/proxy';
import type { ProviderPublic } from '@/lib/types';
import {
  TEST_ADMIN_PASSWORD,
  UPSTREAM_ANTHROPIC_KEY,
  adminHeaders,
  chunkedResponse,
  jsonRequest,
  prepareTestEnv,
  readJson,
  routeContext,
} from './test-helpers';

/**
 * Cross-module boundary tests: client route -> relay -> upstream -> request_logs
 * -> admin logs/stats/keys, plus the streaming lifecycle (chunk boundaries and
 * client disconnects) that the per-module suites do not reach.
 *
 * Nothing here touches the network (fetch is always stubbed) and the database is
 * always DATABASE_PATH=:memory:.
 */

const BASE = 'http://localhost';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface LogRow {
  id: string;
  created_at: number;
  protocol: string;
  path: string;
  model: string | null;
  upstream: string | null;
  status: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  api_key_id: string | null;
  error: string | null;
  stream: number;
}

function logRows(): LogRow[] {
  return queryAll<LogRow>('SELECT * FROM request_logs');
}

function adminRequest(requestPath: string, init: Parameters<typeof jsonRequest>[1] = {}): Request {
  return jsonRequest(`${BASE}${requestPath}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...adminHeaders() },
  });
}

function anthropicProvider(baseUrl = 'https://api.anthropic.com') {
  return createProvider({
    name: 'anthropic-main',
    protocol: 'anthropic',
    baseUrl,
    apiKey: UPSTREAM_ANTHROPIC_KEY,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  prepareTestEnv();
  resetLoginThrottle();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boundary: client route streaming (acceptance: SSE passthrough + one log row)', () => {
  it('answers text/event-stream, forwards upstream bytes untouched and logs stream=1 once', async () => {
    const created = createApiKey('stream-client', 'key-stream');
    anthropicProvider();
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-opus","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => chunkedResponse(chunks)),
    );

    const response = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3-opus', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-api-key': created.key },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // Nothing is buffered: the log row must not exist before the stream terminates.
    expect(logRows()).toHaveLength(0);

    const body = await response.text();
    expect(body).toBe(chunks.join(''));

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      path: '/v1/messages',
      upstream: 'anthropic-main',
      status: 200,
      stream: 1,
      input_tokens: 12,
      output_tokens: 25,
      api_key_id: 'key-stream',
      error: null,
    });
  });

  it('accumulates usage when an SSE event is split across chunk boundaries', async () => {
    anthropicProvider();
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"cla',
      'ude-3-opus","usage":{"input_tokens":12,"output_tokens":',
      '1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => chunkedResponse(chunks)),
    );

    const requestBody = { model: 'client-declared-model', stream: true, messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
      body: requestBody,
      apiKeyId: 'key-split',
    });

    expect(await result.response.text()).toBe(chunks.join(''));
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 200,
      stream: 1,
      input_tokens: 12,
      output_tokens: 30,
      api_key_id: 'key-split',
    });
    // The model reported by the upstream wins over the request body value.
    expect(rows[0]?.model).toBe('claude-3-opus');
  });

  it('writes exactly one row when the client disconnects mid-stream', async () => {
    const created = createApiKey('disconnect-client', 'key-disc');
    anthropicProvider();
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n'),
        );
        // Deliberately never closed: the client gives up first.
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () => new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    );

    const response = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3-opus', stream: true, messages: [] },
        headers: { 'x-api-key': created.key },
      }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(first.done).toBe(false);
    expect(logRows()).toHaveLength(0);

    await reader!.cancel('client went away');
    await waitFor(() => logRows().length > 0);

    // Idempotent finalisation: a cancel must not duplicate the row.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      status: 200,
      stream: 1,
      api_key_id: 'key-disc',
      input_tokens: 5,
    });
    expect(rows[0]?.error ?? '').toMatch(/disconnect/i);
  });

  it('honours an explicit stream:false over an SSE Accept header and buffers the body', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ model: 'claude-3', usage: { input_tokens: 1, output_tokens: 2 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const requestBody = { model: 'claude-3', stream: false, messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(requestBody),
      }),
      body: requestBody,
    });

    // Non-streaming path: the row exists before the client reads the body.
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stream).toBe(0);
    expect(await result.response.text()).toContain('claude-3');
  });

  it('falls back to the Accept header when the body has no stream field', async () => {
    anthropicProvider();
    const chunks = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => chunkedResponse(chunks)),
    );

    const requestBody = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(requestBody),
      }),
      body: requestBody,
    });

    expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    expect(logRows()).toHaveLength(0);
    await result.response.text();
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stream: 1, input_tokens: 3, output_tokens: 9 });
  });
});

describe('boundary: response header hygiene (C9)', () => {
  it('sets text/event-stream when the upstream omits the content type on a stream', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        const encoder = new TextEncoder();
        const upstreamBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(upstreamBody, { status: 200 });
      }),
    );

    const requestBody = { model: 'claude-3', stream: true, messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
      body: requestBody,
    });

    expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    expect(result.response.headers.get('x-accel-buffering')).toBe('no');
    await result.response.text();
    expect(logRows()[0]?.stream).toBe(1);
  });

  it('drops upstream set-cookie but forwards tracing headers', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ model: 'claude-3' }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'upstream_session=leak',
              'x-request-id': 'req_123',
            },
          }),
      ),
    );

    const requestBody = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
      body: requestBody,
    });

    expect(result.response.headers.get('set-cookie')).toBeNull();
    expect(result.response.headers.get('x-request-id')).toBe('req_123');
    await result.response.text();
  });
});

describe('boundary: client authentication (C2)', () => {
  it('accepts a Bearer ar- key on the messages route and prefers x-api-key over a junk Authorization', async () => {
    const created = createApiKey('bearer-client', 'key-bearer');
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ model: 'claude-3' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const viaBearer = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3', messages: [] },
        headers: { authorization: `Bearer ${created.key}` },
      }),
    );
    expect(viaBearer.status).toBe(200);
    await viaBearer.text();

    const viaApiKey = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3', messages: [] },
        headers: { 'x-api-key': created.key, authorization: 'Bearer not-a-real-key' },
      }),
    );
    expect(viaApiKey.status).toBe(200);
    await viaApiKey.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers the exact C2 401 body for a wrong bearer token on both client routes', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    anthropicProvider();

    for (const handler of [messagesRoute.POST, chatRoute.POST]) {
      const response = await handler(
        jsonRequest(`${BASE}/api/v1/messages`, {
          body: { model: 'claude-3', messages: [] },
          headers: { authorization: 'Bearer sk-not-an-aragon-key' },
        }),
      );
      expect(response.status).toBe(401);
      expect(await readJson(response)).toEqual({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a JSON array body with 400 invalid_request_error before touching the upstream', async () => {
    const created = createApiKey('array-body', 'key-array');
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: [{ model: 'claude-3' }],
        headers: { 'x-api-key': created.key },
      }),
    );
    expect(response.status).toBe(400);
    const payload = await readJson<{ error: { type: string } }>(response);
    expect(payload.error.type).toBe('invalid_request_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('boundary: relay -> logs -> stats -> keys consistency', () => {
  it('records one request end-to-end and reports it identically on every admin surface', async () => {
    const created = createApiKey('chain-client', 'key-chain');
    expect(getApiKey('key-chain')?.lastUsedAt).toBeNull();
    anthropicProvider();
    const upstreamPayload = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      model: 'claude-3-5-sonnet',
      usage: { input_tokens: 7, output_tokens: 11 },
      content: [{ type: 'text', text: 'hello' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(upstreamPayload, { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const response = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3-5-sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-api-key': created.key },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamPayload);

    // C5: lastUsedAt is stamped by the client authentication path.
    expect(getApiKey('key-chain')?.lastUsedAt).not.toBeNull();

    // C8: the log row is readable through the admin API.
    const logsResponse = await logsRoute.GET(adminRequest('/api/admin/logs?limit=10', { method: 'GET' }));
    const page = await readJson<{
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>(logsResponse);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3-5-sonnet',
      upstream: 'anthropic-main',
      status: 200,
      inputTokens: 7,
      outputTokens: 11,
      apiKeyId: 'key-chain',
      error: null,
      stream: false,
    });
    expect(page.nextCursor).toBeNull();

    // C7: the dashboard agrees with the log rows.
    const statsResponse = await statsRoute.GET(adminRequest('/api/admin/stats?range=24h', { method: 'GET' }));
    const stats = (
      await readJson<{
        data: {
          range: string;
          totals: { requests: number; inputTokens: number; outputTokens: number; errorRate: number };
          series: Array<{ requests: number }>;
          byModel: Array<Record<string, unknown>>;
          byKey: Array<Record<string, unknown>>;
        };
      }>(statsResponse)
    ).data;
    expect(stats.range).toBe('24h');
    expect(stats.totals).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 11, errorRate: 0 });
    expect(stats.series.reduce((sum, point) => sum + point.requests, 0)).toBe(1);
    expect(stats.byModel).toEqual([
      { model: 'claude-3-5-sonnet', requests: 1, inputTokens: 7, outputTokens: 11 },
    ]);
    expect(stats.byKey).toEqual([{ apiKeyId: 'key-chain', name: 'chain-client', requests: 1 }]);

    const rowCount = queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM request_logs');
    expect(stats.totals.requests).toBe(Number(rowCount?.count));
  });

  it('counts only rows inside the reported window and degrades gracefully for orphan key ids', async () => {
    const now = Date.now();
    const seed = (createdAt: number, model: string, status: number, apiKeyId: string | null) =>
      insertRequestLog({
        protocol: 'anthropic',
        path: '/v1/messages',
        model,
        upstream: 'anthropic-main',
        status,
        latencyMs: 100,
        inputTokens: 1,
        outputTokens: 1,
        apiKeyId,
        error: status >= 400 ? 'boom' : null,
        stream: false,
        createdAt,
      });

    seed(now - 8 * DAY_MS, 'ancient', 200, null); // outside 7d, inside 30d
    seed(now - 30 * HOUR_MS, 'yesterday', 200, null); // outside 24h, inside 7d
    seed(now - 60_000, 'recent', 500, 'ghost-key'); // inside 24h, key no longer exists
    seed(now - 30_000, 'recent', 200, null); // inside 24h

    const readStats = async (range: string) => {
      const response = await statsRoute.GET(
        adminRequest(`/api/admin/stats?range=${range}`, { method: 'GET' }),
      );
      expect(response.status).toBe(200);
      return (
        await readJson<{
          data: {
            range: string;
            totals: { requests: number; errorRate: number };
            series: Array<{ requests: number; errors: number; t: string }>;
            byKey: Array<{ apiKeyId: string | null; name: string; requests: number }>;
          };
        }>(response)
      ).data;
    };

    const day = await readStats('24h');
    expect(day.totals.requests).toBe(2);
    expect(day.totals.errorRate).toBe(0.5);
    expect(day.series).toHaveLength(24);
    expect(day.series.reduce((sum, point) => sum + point.requests, 0)).toBe(2);
    expect(day.series.reduce((sum, point) => sum + point.errors, 0)).toBe(1);
    expect(day.byKey).toEqual(
      expect.arrayContaining([{ apiKeyId: 'ghost-key', name: 'unknown', requests: 1 }]),
    );

    const week = await readStats('7d');
    expect(week.totals.requests).toBe(3);
    expect(week.series).toHaveLength(7);

    const month = await readStats('30d');
    expect(month.totals.requests).toBe(4);
    expect(month.series).toHaveLength(30);

    // Filtering really happens: the table holds more rows than any single window.
    const rowCount = queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM request_logs');
    expect(Number(rowCount?.count)).toBe(4);
    expect(week.totals.requests).toBeLessThan(Number(rowCount?.count));
    for (const stats of [day, week, month]) {
      expect(stats.series.reduce((sum, point) => sum + point.requests, 0)).toBe(stats.totals.requests);
    }
  });
});

describe('boundary: secrets never leave the admin API', () => {
  it('keeps the plaintext upstream key out of every admin response while storing ciphertext', async () => {
    const plaintext = 'sk-ant-top-secret-upstream-9f3';
    const createResponse = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'sweep', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: plaintext },
      }),
    );
    expect(createResponse.status).toBe(200);
    const provider = (await readJson<{ data: ProviderPublic }>(createResponse)).data;

    const bodies: string[] = [JSON.stringify(provider)];
    bodies.push(await (await providersRoute.GET(adminRequest('/api/admin/providers', { method: 'GET' }))).text());
    bodies.push(
      await (
        await providersIdRoute.GET(adminRequest(`/api/admin/providers/${provider.id}`, { method: 'GET' }), routeContext({ id: provider.id }))
      ).text(),
    );
    bodies.push(
      await (
        await providersIdRoute.PATCH(
          adminRequest(`/api/admin/providers/${provider.id}`, { method: 'PATCH', body: { enabled: false } }),
          routeContext({ id: provider.id }),
        )
      ).text(),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'claude-3-opus' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    bodies.push(
      await (
        await providerTestRoute.POST(
          adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
          routeContext({ id: provider.id }),
        )
      ).text(),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('upstream rejected the request', { status: 401 })),
    );
    bodies.push(
      await (
        await providerTestRoute.POST(
          adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
          routeContext({ id: provider.id }),
        )
      ).text(),
    );

    bodies.push(await (await keysRoute.GET(adminRequest('/api/admin/keys', { method: 'GET' }))).text());
    bodies.push(await (await statsRoute.GET(adminRequest('/api/admin/stats?range=7d', { method: 'GET' }))).text());
    bodies.push(await (await logsRoute.GET(adminRequest('/api/admin/logs', { method: 'GET' }))).text());

    for (const body of bodies) {
      expect(body).not.toContain(plaintext);
    }

    const row = queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [provider.id]);
    expect(row?.api_key_enc).toBeTruthy();
    expect(row?.api_key_enc).not.toBe(plaintext);
    expect(row?.api_key_enc).not.toContain(plaintext);
    expect(open(row!.api_key_enc)).toBe(plaintext);
    expect(provider.maskedKey).not.toContain(plaintext);
  });

  it('rotates the ciphertext when a provider key is patched', async () => {
    const created = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'rotate', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-old-key-value' },
      }),
    );
    const provider = (await readJson<{ data: ProviderPublic }>(created)).data;
    const before = queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [provider.id]);

    const patched = await providersIdRoute.PATCH(
      adminRequest(`/api/admin/providers/${provider.id}`, {
        method: 'PATCH',
        body: { apiKey: 'sk-new-key-value' },
      }),
      routeContext({ id: provider.id }),
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.text();
    expect(patchedBody).not.toContain('sk-new-key-value');
    expect(patchedBody).not.toContain('sk-old-key-value');

    const after = queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [provider.id]);
    expect(after?.api_key_enc).not.toBe(before?.api_key_enc);
    expect(open(after!.api_key_enc)).toBe('sk-new-key-value');

    const patchedProvider = JSON.parse(patchedBody) as { data: ProviderPublic };
    expect(patchedProvider.data.maskedKey).not.toBe(provider.maskedKey);
  });
});

describe('boundary: credential redaction for hostile upstreams', () => {
  const reflectedKey = 'sk-ant-reflected-secret-7c1';

  /**
   * REGRESSION (fixed): `testProviderConnection` is documented as "never echoes
   * the credential", but it used to copy up to 200 characters of the upstream
   * error body into the admin reply, and `relay()` did the same with up to 800
   * characters into `request_logs.error`, which `GET /api/admin/logs` serves
   * back. An upstream that reflects the credential therefore leaked the
   * plaintext key through the admin API, violating
   * "任何管理端响应都不含上游明文 key".
   *
   * Both surfaces now scrub the known credential (raw / percent-encoded /
   * JSON-escaped, case-insensitive) before the text is stored or returned.
   * These two cases were `it.fails` while the defect was open.
   */
  it('redacts the credential from the provider test message', async () => {
    const created = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'reflect', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: reflectedKey },
      }),
    );
    const provider = (await readJson<{ data: ProviderPublic }>(created)).data;

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(`invalid x-api-key: ${reflectedKey}`, { status: 401 })),
    );
    const response = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    const body = await response.text();
    expect(body).not.toContain(reflectedKey);
  });

  it('redacts the credential from request_logs.error surfaced by /api/admin/logs', async () => {
    const created = createApiKey('reflect-client', 'key-reflect');
    createProvider({
      name: 'anthropic-reflect',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: reflectedKey,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad key ${reflectedKey}` } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const relayed = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3', messages: [] },
        headers: { 'x-api-key': created.key },
      }),
    );
    await relayed.text();

    const logsBody = await (await logsRoute.GET(adminRequest('/api/admin/logs', { method: 'GET' }))).text();
    expect(logsBody).not.toContain(reflectedKey);
  });
});

describe('boundary: admin idempotency and session hardening', () => {
  it('treats a repeated revoke as idempotent and keeps the original timestamp', async () => {
    createApiKey('idempotent', 'key-idem');
    const first = await keysIdRoute.DELETE(
      adminRequest('/api/admin/keys/key-idem', { method: 'DELETE' }),
      routeContext({ id: 'key-idem' }),
    );
    expect(first.status).toBe(200);
    expect(await readJson(first)).toEqual({ data: { id: 'key-idem' } });
    const firstRevokedAt = queryOne<{ revoked_at: number | null }>(
      'SELECT revoked_at FROM api_keys WHERE id = ?',
      ['key-idem'],
    )?.revoked_at;
    expect(firstRevokedAt).not.toBeNull();

    const second = await keysIdRoute.DELETE(
      adminRequest('/api/admin/keys/key-idem', { method: 'DELETE' }),
      routeContext({ id: 'key-idem' }),
    );
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({ data: { id: 'key-idem' } });
    expect(
      queryOne<{ revoked_at: number | null }>('SELECT revoked_at FROM api_keys WHERE id = ?', ['key-idem'])
        ?.revoked_at,
    ).toBe(firstRevokedAt);
    expect(queryAll('SELECT id FROM api_keys')).toHaveLength(1);
  });

  it('marks the session cookie Secure when the request arrived over HTTPS', async () => {
    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, {
        body: { password: TEST_ADMIN_PASSWORD },
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('locks out password guessing with 429 and refuses the correct password too', async () => {
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await sessionRoute.POST(
        jsonRequest(`${BASE}/api/admin/session`, { body: { password: `wrong-${attempt}` } }),
      );
      expect(response.status).toBe(401);
    }

    const locked = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    expect(locked.status).toBe(429);
    expect(locked.headers.get('set-cookie')).toBeNull();
    const payload = await readJson<{ error: { message: string } }>(locked);
    expect(payload.error.message).toMatch(/too many/i);

    resetLoginThrottle();
    const recovered = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    expect(recovered.status).toBe(200);
  });
});
