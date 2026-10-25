import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as modelsRoute from '@/app/api/v1/models/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { createApiKey, revokeApiKey } from '@/lib/apikeys';
import { queryAll } from '@/lib/db';
import { hasNullBodyStatus, relay } from '@/lib/proxy';
import { createProvider, testProviderConnection } from '@/lib/providers';
import {
  UPSTREAM_ANTHROPIC_KEY,
  UPSTREAM_OPENAI_KEY,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
} from './test-helpers';

/**
 * WP1 · empty-body hardening.
 *
 * The Fetch standard has null-body statuses (204 / 205 / 304): a `Response` for
 * one of them cannot carry a body, so `new Response(bytes, { status: 204 })`
 * throws even when `bytes` is a zero-length buffer. The relay used to forward the
 * (empty) upstream buffer anyway, the `TypeError` was caught by the route and
 * answered as a 502, while `request_logs` had already recorded the real upstream
 * status with `error = null` — the client and the console disagreed about what
 * happened.
 *
 * These cases pin the fixed behaviour end to end: the client receives the
 * upstream status itself, the row records the same status, and nothing is
 * announced as a payload that cannot exist. They also cover the two neighbouring
 * failure modes (an SSE stream that dies mid-flight, and unauthenticated entry
 * points) so a regression in the same area is caught here rather than in the
 * console.
 *
 * Everything is offline: `fetch` is either injected or stubbed, and the database
 * is `:memory:`.
 */

const BASE = 'http://localhost';

/** Statuses the `Response` constructor refuses to carry a body for. */
const NULL_BODY_STATUSES = [204, 205, 304] as const;

interface LogRow {
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
  return queryAll<LogRow>('SELECT * FROM request_logs ORDER BY created_at ASC, id ASC');
}

function anthropicProvider(name = 'anthropic-main') {
  return createProvider({
    name,
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: UPSTREAM_ANTHROPIC_KEY,
  });
}

function openaiProvider(name = 'openai-main') {
  return createProvider({
    name,
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: UPSTREAM_OPENAI_KEY,
  });
}

/** A `fetch` stub that always answers the given status with no body. */
function stubFetchStatus(status: number, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async () => new Response(null, { status, headers }));
}

function clientRequest(path: string, apiKey: string, body: unknown): Request {
  return jsonRequest(`${BASE}${path}`, {
    body,
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for the expected state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('null-body status predicate', () => {
  it('matches exactly the statuses the Response constructor refuses a body for', () => {
    for (const status of NULL_BODY_STATUSES) {
      expect(hasNullBodyStatus(status), String(status)).toBe(true);
    }
    for (const status of [200, 201, 206, 301, 400, 429, 500, 529]) {
      expect(hasNullBodyStatus(status), String(status)).toBe(false);
    }
    // The predicate exists because the runtime enforces exactly this set.
    for (const status of NULL_BODY_STATUSES) {
      expect(() => new Response(null, { status }), String(status)).not.toThrow();
      expect(() => new Response(new Uint8Array(0), { status }), String(status)).toThrow(TypeError);
    }
  });
});

describe('relay: a null-body upstream status is forwarded unchanged (C9)', () => {
  for (const status of NULL_BODY_STATUSES) {
    it(`answers ${status} with no body and records the same status`, async () => {
      anthropicProvider();
      const fetchMock = stubFetchStatus(status);
      const body = { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] };

      const result = await relay({
        protocol: 'anthropic',
        request: clientRequest('/api/v1/messages', 'ar-client', body),
        body,
        apiKeyId: 'key-null-body',
        fetchImpl: fetchMock,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The upstream status reaches the client: no 502 invented by a Response
      // constructor `TypeError`.
      expect(result.response.status).toBe(status);
      expect(result.response.status).not.toBe(502);
      // No payload is announced, and no body exists.
      expect(result.response.body).toBeNull();
      expect(await result.response.text()).toBe('');
      expect(result.response.headers.get('content-type')).toBeNull();
      expect(result.response.headers.get('content-length')).toBeNull();
      expect(result.response.headers.get('transfer-encoding')).toBeNull();

      // The draft and the persisted row agree with the client.
      expect(result.log.status).toBe(status);
      expect(result.log.error).toBeNull();
      const rows = logRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        protocol: 'anthropic',
        path: '/v1/messages',
        model: 'claude-3-5-sonnet',
        upstream: 'anthropic-main',
        status,
        input_tokens: null,
        output_tokens: null,
        api_key_id: 'key-null-body',
        error: null,
        stream: 0,
      });
      expect(JSON.stringify(rows[0])).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    });
  }

  it('keeps representation metadata on a 304 but the payload type is dropped', async () => {
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 304,
          headers: { 'content-type': 'application/json', etag: '"v3"', 'cache-control': 'max-age=60' },
        }),
    );
    const body = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', 'ar-client', body),
      body,
      fetchImpl: fetchMock,
    });

    expect(result.response.status).toBe(304);
    expect(result.response.body).toBeNull();
    // A type would make an SDK wait for a body that can never arrive.
    expect(result.response.headers.get('content-type')).toBeNull();
    // Caching metadata the upstream actually sent still flows through.
    expect(result.response.headers.get('etag')).toBe('"v3"');
    expect(result.response.headers.get('cache-control')).toBe('max-age=60');
    expect(logRows()[0]).toMatchObject({ status: 304, error: null });
  });

  it('answers an empty 200 body with a null body and does not invent an error', async () => {
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '0' } }),
    );
    const body = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', 'ar-client', body),
      body,
      fetchImpl: fetchMock,
    });

    expect(result.response.status).toBe(200);
    // An empty buffer and "no payload" are the same fact; state it plainly.
    expect(result.response.body).toBeNull();
    expect(await result.response.text()).toBe('');
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 200, error: null, input_tokens: null, output_tokens: null });
  });
});

describe('relay: stream:true with a null-body upstream status (C9)', () => {
  it('answers 204 without a body and logs stream=1 with no error', async () => {
    anthropicProvider();
    const fetchMock = stubFetchStatus(204);
    const body = { model: 'claude-3', stream: true, messages: [] };

    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', 'ar-client', body),
      body,
      apiKeyId: 'key-stream-204',
      fetchImpl: fetchMock,
    });

    expect(result.response.status).toBe(204);
    expect(result.response.body).toBeNull();
    // A 204 cannot be an event stream: no SSE label may survive.
    expect(result.response.headers.get('content-type')).toBeNull();
    expect(await result.response.text()).toBe('');

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 204,
      stream: 1,
      error: null,
      api_key_id: 'key-stream-204',
    });
    expect(result.log.error).toBeNull();
  });

  it('does not log a 304 as an error just because it is not 2xx', async () => {
    openaiProvider();
    const fetchMock = stubFetchStatus(304);
    const body = { model: 'gpt-4o-mini', stream: true, messages: [] };

    const result = await relay({
      protocol: 'openai',
      request: clientRequest('/api/v1/chat/completions', 'ar-client', body),
      body,
      fetchImpl: fetchMock,
    });

    expect(result.response.status).toBe(304);
    expect(result.response.body).toBeNull();
    // The client received exactly what the upstream said: nothing failed, so the
    // row must not claim an error (that is the old 502/error=null contradiction
    // from the other side).
    expect(result.log.error).toBeNull();
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ protocol: 'openai', status: 304, stream: 1, error: null });
  });
});

describe('client routes: a body-less upstream answer reaches the client as-is', () => {
  it('answers POST /api/v1/messages with the upstream 204 (never 502) and logs 204/error=null', async () => {
    anthropicProvider();
    const created = createApiKey('route-204', 'key-route-204');
    const fetchMock = stubFetchStatus(204);
    vi.stubGlobal('fetch', fetchMock);

    const response = await messagesRoute.POST(
      clientRequest('/api/v1/messages', created.key, { model: 'claude-3', messages: [] }),
    );

    expect(response.status).toBe(204);
    expect(response.status).not.toBe(502);
    expect(await response.text()).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 204, error: null, api_key_id: 'key-route-204', protocol: 'anthropic' });
  });

  it('answers POST /api/v1/chat/completions with the upstream 304 and logs the same status', async () => {
    openaiProvider();
    const created = createApiKey('route-304', 'key-route-304');
    const fetchMock = stubFetchStatus(304);
    vi.stubGlobal('fetch', fetchMock);

    const response = await chatRoute.POST(
      clientRequest('/api/v1/chat/completions', created.key, { model: 'gpt-4o-mini', messages: [] }),
    );

    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 304,
      error: null,
      api_key_id: 'key-route-304',
      protocol: 'openai',
      path: '/v1/chat/completions',
    });
  });

  it('surfaces the 204 consistently on /api/admin/logs, /api/admin/stats and /api/admin/providers', async () => {
    anthropicProvider();
    const created = createApiKey('admin-consistency', 'key-admin-consistency');
    vi.stubGlobal('fetch', stubFetchStatus(204));

    const relayed = await messagesRoute.POST(
      clientRequest('/api/v1/messages', created.key, { model: 'claude-3', messages: [] }),
    );
    expect(relayed.status).toBe(204);

    const logsResponse = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(logsResponse.status).toBe(200);
    const logsPayload = await readJson<{
      data: Array<{ status: number; error: string | null; stream: boolean; apiKeyId: string | null }>;
      nextCursor: string | null;
    }>(logsResponse);
    expect(logsPayload.data).toHaveLength(1);
    // C8 shape, and the same status the client received.
    expect(logsPayload.data[0]).toMatchObject({
      status: 204,
      error: null,
      stream: false,
      apiKeyId: 'key-admin-consistency',
    });
    expect(logsPayload.nextCursor).toBeNull();

    const statsResponse = await statsRoute.GET(
      jsonRequest(`${BASE}/api/admin/stats?range=24h`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(statsResponse.status).toBe(200);
    const statsPayload = await readJson<{
      data: { totals: { requests: number; errorRate: number } };
    }>(statsResponse);
    expect(statsPayload.data.totals.requests).toBe(1);
    // A 204 is not an error, so the dashboard must not report one.
    expect(statsPayload.data.totals.errorRate).toBe(0);

    const providersResponse = await providersRoute.GET(
      jsonRequest(`${BASE}/api/admin/providers`, { method: 'GET', headers: adminHeaders() }),
    );
    const providersText = await providersResponse.text();
    expect(providersText).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    expect(providersText).toContain('maskedKey');
  });
});

describe('SSE interruption: an upstream stream that dies mid-flight', () => {
  it('writes exactly one error row and forwards the chunks received so far', async () => {
    anthropicProvider();
    const encoder = new TextEncoder();
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(
          encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":6}}}\n\n'),
        );
      },
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const body = { model: 'claude-3', stream: true, messages: [] };

    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', 'ar-client', body),
      body,
      apiKeyId: 'key-sse-cut',
      fetchImpl: fetchMock,
    });
    expect(result.response.headers.get('content-type')).toContain('text/event-stream');

    const reader = result.response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('message_start');
    // Nothing is logged while the stream is still live.
    expect(logRows()).toHaveLength(0);

    upstreamController.error(new Error('upstream socket reset'));
    await expect(reader!.read()).rejects.toThrow();

    await waitFor(() => logRows().length > 0);
    // The finaliser is idempotent: an interrupted stream still yields one row.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      status: 200,
      stream: 1,
      api_key_id: 'key-sse-cut',
      input_tokens: 6,
      error: 'upstream stream failed',
    });
    expect(JSON.stringify(rows[0])).not.toContain(UPSTREAM_ANTHROPIC_KEY);
  });
});

describe('provider probe: a null-body upstream answer is reported truthfully (C6)', () => {
  it('reports the real status of a model probe that answered 204 and never echoes the key', async () => {
    const provider = anthropicProvider('probe-204');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    const result = await testProviderConnection(
      {
        id: provider.id,
        name: provider.name,
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: UPSTREAM_ANTHROPIC_KEY,
      },
      fetchMock,
    );

    // Reachable, but there is no model list: the message says 204, not 200.
    expect(result.ok).toBe(true);
    expect(result.message).toContain('204');
    expect(result.message).not.toContain('200');
    expect(result.message).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts the models of a normal 200 answer', async () => {
    const provider = anthropicProvider('probe-200');
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }),
    );

    const result = await testProviderConnection(
      {
        id: provider.id,
        name: provider.name,
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: UPSTREAM_ANTHROPIC_KEY,
      },
      fetchMock,
    );

    expect(result).toEqual({ ok: true, message: 'upstream reachable: GET /v1/models returned 2 models' });
  });
});

describe('unauthorized surfaces stay closed (C2 / C3)', () => {
  it('answers the exact C2 401 on GET /api/v1/models without touching an upstream', async () => {
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await modelsRoute.GET(jsonRequest(`${BASE}/api/v1/models`, { method: 'GET' }));

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logRows()).toHaveLength(0);
  });

  it('rejects a revoked key on both client entry points and logs nothing', async () => {
    anthropicProvider();
    openaiProvider();
    const created = createApiKey('revoked-client', 'key-revoked');
    expect(revokeApiKey('key-revoked')).toBe(true);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const calls: Array<{ name: string; run: () => Promise<Response> }> = [
      {
        name: 'messages',
        run: () =>
          messagesRoute.POST(
            clientRequest('/api/v1/messages', created.key, { model: 'claude-3', messages: [] }),
          ),
      },
      {
        name: 'chat completions',
        run: () =>
          chatRoute.POST(
            clientRequest('/api/v1/chat/completions', created.key, { model: 'gpt-4o-mini', messages: [] }),
          ),
      },
    ];

    for (const call of calls) {
      const response = await call.run();
      expect(response.status, call.name).toBe(401);
      expect(await readJson(response), call.name).toEqual({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
    }
    // An unauthenticated call must never reach an upstream or create a log row.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logRows()).toHaveLength(0);
  });
});
