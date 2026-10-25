import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providerTestRoute from '@/app/api/admin/providers/[id]/test/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { getApiKey } from '@/lib/apikeys';
import { open } from '@/lib/crypto';
import { execute, queryAll, queryOne } from '@/lib/db';
import type { ApiKeyPublic, ProviderPublic } from '@/lib/types';
import {
  UPSTREAM_ANTHROPIC_KEY,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
  routeContext,
} from './test-helpers';

/**
 * Contract sweep: the acceptance criteria and the C1/C2/C4/C5/C6/C7/C8/C9/C12
 * contracts exercised *through the real route handlers* rather than through the
 * library functions underneath them.
 *
 * Everything here is deterministic and offline: `fetch` is always stubbed with a
 * local `Response`, and `DATABASE_PATH` is `:memory:` (see `prepareTestEnv`).
 */

const BASE = 'http://localhost';

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
  return queryAll<LogRow>('SELECT * FROM request_logs ORDER BY created_at ASC, id ASC');
}

function adminRequest(path: string, init: Parameters<typeof jsonRequest>[1] = {}): Request {
  return jsonRequest(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...adminHeaders() },
  });
}

function clientRequest(path: string, apiKey: string, body: unknown): Request {
  return jsonRequest(`${BASE}${path}`, {
    body,
    headers: {
      'x-api-key': apiKey,
      accept: 'application/json',
    },
  });
}

/** Create a provider through the admin API and return its public representation. */
async function createProviderViaApi(
  body: Record<string, unknown>,
): Promise<{ provider: ProviderPublic; response: Response }> {
  const response = await providersRoute.POST(
    adminRequest('/api/admin/providers', { body }),
  );
  expect(response.status).toBe(200);
  const payload = await readJson<{ data: ProviderPublic }>(response);
  return { provider: payload.data, response };
}

/** Create a client key through the admin API and return the one-time plaintext. */
async function createKeyViaApi(name: string): Promise<{ id: string; key: string }> {
  const response = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name } }));
  expect(response.status).toBe(200);
  const payload = await readJson<{ data: ApiKeyPublic & { key: string } }>(response);
  return { id: payload.data.id, key: payload.data.key };
}

function stubFetchOnce(factory: () => Response | Promise<Response>): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>(async () => factory());
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('C12: schema constraints are enforced by SQLite, not only by TypeScript', () => {
  it('keeps key_hash unique, rejects unknown protocols and defaults the log columns', () => {
    const insertKey = (id: string, hash: string) =>
      execute(
        'INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
        [id, 'n', 'ar-00000000', hash, 1],
      );
    insertKey('k1', 'digest-1');
    expect(() => insertKey('k2', 'digest-1')).toThrow(/UNIQUE constraint failed: api_keys\.key_hash/);

    expect(() =>
      execute(
        'INSERT INTO providers (id, name, protocol, base_url, api_key_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['p1', 'n', 'gemini', 'https://example.test', 'enc', 1, 1],
      ),
    ).toThrow(/CHECK constraint failed/);

    execute("INSERT INTO settings (key, value) VALUES ('ui.theme', 'dark')");
    expect(() => execute("INSERT INTO settings (key, value) VALUES ('ui.theme', 'light')")).toThrow(
      /UNIQUE constraint failed: settings\.key/,
    );

    // C12 defaults: a partial insert must still produce a usable row.
    execute(
      "INSERT INTO request_logs (id, created_at, protocol, path, status) VALUES ('log-1', 1, 'anthropic', '/v1/messages', 200)",
    );
    const row = queryOne<{ latency_ms: number; stream: number; input_tokens: number | null }>(
      "SELECT latency_ms, stream, input_tokens FROM request_logs WHERE id = 'log-1'",
    );
    expect(Number(row?.latency_ms)).toBe(0);
    expect(Number(row?.stream)).toBe(0);
    expect(row?.input_tokens).toBeNull();
  });

  it('serves the log range query from the created_at index required by C12', () => {
    const plan = queryAll<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT * FROM request_logs WHERE created_at >= 0',
    ).map((entry) => String(entry.detail));
    expect(plan.join(' | ')).toContain('idx_request_logs_created_at');
  });
});

describe('C5+C6+C9: a provider and a key created through the admin API drive a real relay', () => {
  it('stores AES-256-GCM ciphertext, relays through the new provider and logs the call', async () => {
    const { provider } = await createProviderViaApi({
      name: 'primary-anthropic',
      protocol: 'anthropic',
      // Trailing /v1 exercises the "do not duplicate /v1" rule of C9 end to end.
      baseUrl: 'https://relay.internal/v1',
      apiKey: UPSTREAM_ANTHROPIC_KEY,
    });
    expect(provider).toMatchObject({
      name: 'primary-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://relay.internal/v1',
      enabled: true,
    });
    // C6: the public projection carries a masked rendering only.
    expect(provider.maskedKey).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    expect(provider.maskedKey).toContain('…');

    // Acceptance: the providers row holds AES-256-GCM ciphertext (iv|tag|ciphertext).
    const stored = queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [
      provider.id,
    ]);
    const ciphertext = String(stored?.api_key_enc);
    expect(ciphertext).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const raw = Buffer.from(ciphertext, 'base64');
    expect(raw.length).toBe(12 + 16 + Buffer.byteLength(UPSTREAM_ANTHROPIC_KEY));
    expect(open(ciphertext)).toBe(UPSTREAM_ANTHROPIC_KEY);

    const client = await createKeyViaApi('first-client');
    expect(client.key).toMatch(/^ar-[0-9a-f]{32}$/);

    const seen: Array<{ url: string; init: RequestInit }> = [];
    const upstreamPayload = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      model: 'claude-3-5-sonnet',
      usage: { input_tokens: 9, output_tokens: 4 },
      content: [{ type: 'text', text: 'ok' }],
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(upstreamPayload, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, {
        model: 'claude-3-5-sonnet',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamPayload);

    // C9: exact upstream target and credential injection for the provider above.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://relay.internal/v1/messages');
    const sent = new Headers(seen[0]?.init.headers);
    expect(sent.get('x-api-key')).toBe(UPSTREAM_ANTHROPIC_KEY);
    expect(sent.get('anthropic-version')).toBe('2023-06-01');
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('cookie')).toBeNull();
    expect(seen[0]?.init.method).toBe('POST');

    // The row that every admin surface reads back.
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3-5-sonnet',
      upstream: 'primary-anthropic',
      status: 200,
      input_tokens: 9,
      output_tokens: 4,
      api_key_id: client.id,
      stream: 0,
    });

    // C5 + C7: the key usage stamp and the dashboard agree with the row.
    expect(getApiKey(client.id)?.lastUsedAt).not.toBeNull();
    const statsResponse = await statsRoute.GET(
      adminRequest('/api/admin/stats?range=24h', { method: 'GET' }),
    );
    const stats = await readJson<{
      data: {
        totals: { requests: number; inputTokens: number; outputTokens: number };
        byModel: Array<{ model: string; requests: number }>;
        byKey: Array<{ apiKeyId: string; name: string; requests: number }>;
      };
    }>(statsResponse);
    expect(stats.data.totals).toMatchObject({ requests: 1, inputTokens: 9, outputTokens: 4 });
    expect(stats.data.byModel[0]?.model).toBe('claude-3-5-sonnet');
    expect(stats.data.byKey).toEqual([{ apiKeyId: client.id, name: 'first-client', requests: 1 }]);

    // No admin response exposes the upstream secret: sweep the admin surfaces.
    const providerList = await providersRoute.GET(
      adminRequest('/api/admin/providers', { method: 'GET' }),
    );
    const logList = await logsRoute.GET(adminRequest('/api/admin/logs', { method: 'GET' }));
    for (const body of [await providerList.text(), await logList.text(), JSON.stringify(stats)]) {
      expect(body).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    }
  });

  it('stops relaying the moment the only provider is disabled or deleted (PATCH/DELETE)', async () => {
    const { provider } = await createProviderViaApi({
      name: 'primary-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://relay.internal',
      apiKey: UPSTREAM_ANTHROPIC_KEY,
    });
    const client = await createKeyViaApi('ops-client');
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // 1. Turn the provider off through the admin API.
    const patched = await providersIdRoute.PATCH(
      adminRequest(`/api/admin/providers/${provider.id}`, {
        method: 'PATCH',
        body: { enabled: false },
      }),
      routeContext({ id: provider.id }),
    );
    expect(patched.status).toBe(200);
    const patchedBody = await readJson<{ data: ProviderPublic }>(patched);
    expect(patchedBody.data.enabled).toBe(false);
    // C6: an omitted apiKey keeps the stored credential untouched.
    expect(patchedBody.data.maskedKey).toBe(provider.maskedKey);

    const disabled = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, { model: 'm', messages: [] }),
    );
    expect(disabled.status).toBe(503);
    expect(await readJson(disabled)).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'no enabled anthropic provider is configured',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logRows().at(-1)).toMatchObject({
      status: 503,
      upstream: null,
      api_key_id: client.id,
      error: 'no enabled anthropic provider is configured',
    });

    // 2. Re-enable, then delete: the next call must fail the same way.
    const reenabled = await providersIdRoute.PATCH(
      adminRequest(`/api/admin/providers/${provider.id}`, {
        method: 'PATCH',
        body: { enabled: true },
      }),
      routeContext({ id: provider.id }),
    );
    expect((await readJson<{ data: ProviderPublic }>(reenabled)).data.enabled).toBe(true);

    const deleted = await providersIdRoute.DELETE(
      adminRequest(`/api/admin/providers/${provider.id}`, { method: 'DELETE' }),
      routeContext({ id: provider.id }),
    );
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toEqual({ data: { id: provider.id } });

    const afterDelete = await chatRoute.POST(
      clientRequest('/api/v1/chat/completions', client.key, { model: 'm', messages: [] }),
    );
    expect(afterDelete.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();

    // C6: probing a deleted provider is a 404 in the C4 error envelope.
    const probe = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { method: 'POST' }),
      routeContext({ id: provider.id }),
    );
    expect(probe.status).toBe(404);
    expect(await readJson(probe)).toEqual({ error: { message: 'provider not found' } });
  });
});

describe('C9: SSE passthrough is byte-exact even across frame and UTF-8 splits', () => {
  it('forwards every upstream byte unchanged and logs one stream row with usage', async () => {
    await createProviderViaApi({
      name: 'stream-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://relay.internal',
      apiKey: UPSTREAM_ANTHROPIC_KEY,
    });
    const client = await createKeyViaApi('stream-client');

    const frames =
      'event: message_start\r\n' +
      'data: {"type":"message_start","message":{"model":"claude-3-5-sonnet","usage":{"input_tokens":12}}}\r\n' +
      '\r\n' +
      'event: content_block_delta\r\n' +
      'data: {"type":"content_block_delta","delta":{"text":"héllo 🌍"}}\r\n' +
      '\r\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":7}}\r\n' +
      '\r\n' +
      'data: [DONE]\r\n' +
      '\r\n';
    const encoder = new TextEncoder();
    const all = encoder.encode(frames);
    // Split *inside* the four byte emoji so a decoder that is not stream aware
    // would corrupt the payload if the relay ever re-encoded it.
    const emojiIndex = frames.indexOf('🌍');
    const splitAt = encoder.encode(frames.slice(0, emojiIndex)).length + 2;
    const first = all.slice(0, splitAt);
    const second = all.slice(splitAt);
    const chunks = [first, second, new Uint8Array(0)];

    const fetchMock = stubFetchOnce(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const response = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, {
        model: 'claude-3-5-sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.byteLength).toBe(all.byteLength);
    expect(Buffer.from(received).equals(Buffer.from(all))).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(sent.get('accept')).toBe('text/event-stream');

    // Exactly one row, written when the stream flushed, with the extracted usage.
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3-5-sonnet',
      upstream: 'stream-anthropic',
      status: 200,
      input_tokens: 12,
      output_tokens: 7,
      api_key_id: client.id,
      stream: 1,
      error: null,
    });
  });
});

describe('body-less upstream statuses (204 / 205 / 304)', () => {
  it('relays the upstream status unchanged, with no body, and logs that same status', async () => {
    await createProviderViaApi({
      name: 'quirky-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://relay.internal',
      apiKey: UPSTREAM_ANTHROPIC_KEY,
    });
    const client = await createKeyViaApi('degraded-client');

    const statuses = [204, 205, 304];
    for (const status of statuses) {
      vi.unstubAllGlobals();
      const fetchMock = stubFetchOnce(() => new Response(null, { status }));
      const response = await messagesRoute.POST(
        clientRequest('/api/v1/messages', client.key, { model: 'm', messages: [] }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The client receives the upstream status itself. A 502 here would mean the
      // relay crashed while building the response (`Response` rejects any body on a
      // null-body status) and silently replaced a valid upstream answer.
      expect(response.status, `upstream ${status}`).toBe(status);
      // Nothing is announced as a payload the status cannot carry.
      expect(response.body, `upstream ${status}`).toBeNull();
      expect(await response.text()).toBe('');
      expect(response.headers.get('content-type')).toBeNull();
      expect(response.headers.get('transfer-encoding')).toBeNull();
      expect(response.headers.get('content-length')).toBeNull();

      // The log row and the client answer agree: same status, and no error was
      // invented for an answer the client received successfully.
      const matching = logRows().filter((row) => row.status === status);
      expect(matching, `upstream ${status}`).toHaveLength(1);
      const row = matching[0]!;
      expect(row.error).toBeNull();
      expect(row.api_key_id).toBe(client.id);
      expect(row.stream).toBe(0);
      expect(row.upstream).toBe('quirky-anthropic');
      expect(JSON.stringify(row)).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    }

    expect(logRows()).toHaveLength(statuses.length);
    expect(logRows().map((row) => row.status).sort((a, b) => a - b)).toEqual([204, 205, 304]);
  });
});

describe('C7: totals equal the log table for route-driven mixed traffic', () => {
  it('counts streams, successes and upstream failures exactly once and reports one error rate', async () => {
    const { provider } = await createProviderViaApi({
      name: 'mixed-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://relay.internal',
      apiKey: UPSTREAM_ANTHROPIC_KEY,
    });
    expect(provider.enabled).toBe(true);
    // The two entry points route to their own provider (C9 pickProvider per protocol).
    await createProviderViaApi({
      name: 'mixed-openai',
      protocol: 'openai',
      baseUrl: 'https://relay.internal/openai',
      apiKey: 'sk-openai-upstream-secret-value',
    });
    const client = await createKeyViaApi('mixed-client');

    const sse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n'),
          );
          controller.enqueue(
            encoder.encode('data: {"type":"message_delta","usage":{"output_tokens":50}}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const upstreamError = new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
      status: 529,
      headers: { 'content-type': 'application/json' },
    });
    const okBody = new Response(
      JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const queue = [sse, upstreamError, okBody];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const next = queue.shift();
      if (!next) throw new Error('unexpected extra upstream call');
      return next;
    });
    vi.stubGlobal('fetch', fetchMock);

    const streamed = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, { model: 'claude-3', stream: true, messages: [] }),
    );
    expect(streamed.status).toBe(200);
    await streamed.text();

    const failed = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, { model: 'claude-3', messages: [] }),
    );
    expect(failed.status).toBe(529);

    const succeeded = await chatRoute.POST(
      clientRequest('/api/v1/chat/completions', client.key, { model: 'gpt-4o', messages: [] }),
    );
    expect(succeeded.status).toBe(200);
    expect(await succeeded.text()).toContain('prompt_tokens');

    const statsResponse = await statsRoute.GET(
      adminRequest('/api/admin/stats?range=24h', { method: 'GET' }),
    );
    const { data } = await readJson<{
      data: {
        range: string;
        totals: { requests: number; inputTokens: number; outputTokens: number; errorRate: number };
        series: Array<{ requests: number; errors: number }>;
        byModel: Array<{ model: string; requests: number }>;
        byKey: Array<{ apiKeyId: string; name: string; requests: number }>;
      };
    }>(statsResponse);

    const tableRows = Number(
      queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM request_logs')?.count,
    );
    expect(tableRows).toBe(3);
    expect(data.range).toBe('24h');
    expect(data.totals.requests).toBe(tableRows);
    expect(data.series.reduce((sum, point) => sum + point.requests, 0)).toBe(tableRows);
    expect(data.series.reduce((sum, point) => sum + point.errors, 0)).toBe(1);
    expect(data.totals.errorRate).toBe(Number((1 / 3).toFixed(4)));
    expect(data.totals.inputTokens).toBe(103);
    expect(data.totals.outputTokens).toBe(52);
    expect(data.byModel).toEqual(
      expect.arrayContaining([
        { model: 'claude-3', requests: 2, inputTokens: 100, outputTokens: 50 },
        { model: 'gpt-4o', requests: 1, inputTokens: 3, outputTokens: 2 },
      ]),
    );
    expect(data.byKey).toEqual([{ apiKeyId: client.id, name: 'mixed-client', requests: 3 }]);

    // C8: the same three rows are visible, newest first, with the stream flag intact.
    const logsResponse = await logsRoute.GET(adminRequest('/api/admin/logs?limit=10', { method: 'GET' }));
    const page = await readJson<{
      data: Array<{ status: number; stream: boolean; protocol: string; error: string | null }>;
      nextCursor: string | null;
    }>(logsResponse);
    expect(page.data).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
    expect(page.data.filter((row) => row.stream)).toHaveLength(1);
    expect(page.data.map((row) => row.status).sort()).toEqual([200, 200, 529]);
    expect(page.data.find((row) => row.status === 529)?.error).toContain('overloaded');
  });
});

describe('C5: the plaintext client key is never persisted or replayed', () => {
  it('rejects the revoked key with the exact C2 body and keeps the historical rows', async () => {
    await createProviderViaApi({
      name: 'revoke-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://relay.internal',
      apiKey: UPSTREAM_ANTHROPIC_KEY,
    });
    const client = await createKeyViaApi('to-be-revoked');

    const fetchMock = stubFetchOnce(
      () =>
        new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const first = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, { model: 'm', messages: [] }),
    );
    expect(first.status).toBe(200);
    await first.text();

    // The plaintext key exists nowhere in the database.
    const dumped = JSON.stringify(queryAll('SELECT * FROM api_keys'));
    expect(dumped).not.toContain(client.key);
    expect(dumped).toContain(client.key.slice(0, 10));

    const revoked = await keysIdRoute.DELETE(
      adminRequest(`/api/admin/keys/${client.id}`, { method: 'DELETE' }),
      routeContext({ id: client.id }),
    );
    expect(revoked.status).toBe(200);
    expect(await readJson(revoked)).toEqual({ data: { id: client.id } });

    fetchMock.mockClear();
    const rejected = await messagesRoute.POST(
      clientRequest('/api/v1/messages', client.key, { model: 'm', messages: [] }),
    );
    expect(rejected.status).toBe(401);
    expect(await readJson(rejected)).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The row from before the revocation is still readable and correctly attributed.
    const page = await readJson<{ data: Array<{ apiKeyId: string; status: number }> }>(
      await logsRoute.GET(adminRequest('/api/admin/logs', { method: 'GET' })),
    );
    expect(page.data).toEqual([expect.objectContaining({ apiKeyId: client.id, status: 200 })]);
    expect(logRows()).toHaveLength(1);
  });
});
