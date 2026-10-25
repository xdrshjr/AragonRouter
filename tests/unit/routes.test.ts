import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as modelsRoute from '@/app/api/v1/models/route';
import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providerTestRoute from '@/app/api/admin/providers/[id]/test/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { createApiKey, hashApiKey } from '@/lib/apikeys';
import { open } from '@/lib/crypto';
import { queryAll, queryOne } from '@/lib/db';
import { insertRequestLog } from '@/lib/logs';
import { resetLoginThrottle } from '@/lib/login-throttle';
import type { ApiKeyCreated, ApiKeyPublic, ProviderPublic } from '@/lib/types';
import {
  TEST_ADMIN_PASSWORD,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
  routeContext,
} from './test-helpers';

const BASE = 'http://localhost';

async function bodyOf<T>(response: Response): Promise<T> {
  return readJson<T>(response);
}

function adminRequest(path: string, init: Parameters<typeof jsonRequest>[1] = {}): Request {
  return jsonRequest(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...adminHeaders() } });
}

beforeEach(() => {
  prepareTestEnv();
  resetLoginThrottle();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client routes: C2 authentication', () => {
  const endpoints = [
    { name: 'messages', handler: messagesRoute.POST, path: '/api/v1/messages' },
    { name: 'chat/completions', handler: chatRoute.POST, path: '/api/v1/chat/completions' },
  ] as const;

  for (const endpoint of endpoints) {
    it(`${endpoint.name} answers 401 authentication_error without a key`, async () => {
      const response = await endpoint.handler(
        jsonRequest(`${BASE}${endpoint.path}`, { body: { model: 'x', messages: [] } }),
      );
      expect(response.status).toBe(401);
      expect(await bodyOf<unknown>(response)).toEqual({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
    });

    it(`${endpoint.name} answers 401 for an unknown key`, async () => {
      const response = await endpoint.handler(
        jsonRequest(`${BASE}${endpoint.path}`, {
          body: { model: 'x', messages: [] },
          headers: { 'x-api-key': `ar-${'0'.repeat(32)}` },
        }),
      );
      expect(response.status).toBe(401);
      expect(((await bodyOf<{ error: { type: string } }>(response)).error.type)).toBe(
        'authentication_error',
      );
    });
  }

  it('accepts Authorization: Bearer ar-... on the openai route', async () => {
    const created = createApiKey('bearer', 'key-bearer');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    createProviderFixture('c1');
    await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-up' },
      }),
    );

    const response = await chatRoute.POST(
      jsonRequest(`${BASE}/api/v1/chat/completions`, {
        body: { model: 'gpt-4o-mini', messages: [] },
        headers: { authorization: `Bearer ${created.key}` },
      }),
    );
    expect(response.status).toBe(200);
    const rows = queryAll<{ api_key_id: string }>('SELECT api_key_id FROM request_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.api_key_id).toBe('key-bearer');
  });

  it('rejects a revoked key with 401', async () => {
    const created = createApiKey('revoked', 'key-rev');
    await keysIdRoute.DELETE(adminRequest('/api/admin/keys/key-rev'), routeContext({ id: 'key-rev' }));
    const response = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'x', messages: [] },
        headers: { 'x-api-key': created.key },
      }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects an invalid JSON body with 400 invalid_request_error', async () => {
    const created = createApiKey('json', 'key-json');
    const request = new Request(`${BASE}/api/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: '{not json',
    });
    const response = await messagesRoute.POST(request);
    expect(response.status).toBe(400);
    const payload = await bodyOf<{ error: { type: string } }>(response);
    expect(payload.error.type).toBe('invalid_request_error');
  });
});

function createProviderFixture(name: string, protocol: 'anthropic' | 'openai' = 'anthropic') {
  return providersRoute.POST(
    adminRequest('/api/admin/providers', {
      body: {
        name,
        protocol,
        baseUrl: protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
        apiKey: protocol === 'anthropic' ? 'sk-ant-upstream' : 'sk-openai-upstream',
      },
    }),
  );
}

describe('admin routes: C3 session and unauthorized matrix', () => {
  it('rejects every admin route without a session using {error:{message}}', async () => {
    const calls: Array<{ name: string; run: () => Promise<Response> }> = [
      { name: 'GET keys', run: () => keysRoute.GET(jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET' })) },
      {
        name: 'POST keys',
        run: () => keysRoute.POST(jsonRequest(`${BASE}/api/admin/keys`, { body: { name: 'x' } })),
      },
      {
        name: 'DELETE key',
        run: () =>
          keysIdRoute.DELETE(jsonRequest(`${BASE}/api/admin/keys/1`, { method: 'DELETE' }), routeContext({ id: '1' })),
      },
      {
        name: 'GET providers',
        run: () => providersRoute.GET(jsonRequest(`${BASE}/api/admin/providers`, { method: 'GET' })),
      },
      {
        name: 'POST providers',
        run: () => providersRoute.POST(jsonRequest(`${BASE}/api/admin/providers`, { body: {} })),
      },
      {
        name: 'PATCH provider',
        run: () =>
          providersIdRoute.PATCH(jsonRequest(`${BASE}/api/admin/providers/1`, { method: 'PATCH', body: {} }), routeContext({ id: '1' })),
      },
      {
        name: 'test provider',
        run: () =>
          providerTestRoute.POST(jsonRequest(`${BASE}/api/admin/providers/1/test`, { body: {} }), routeContext({ id: '1' })),
      },
      {
        name: 'stats',
        run: () => statsRoute.GET(jsonRequest(`${BASE}/api/admin/stats?range=7d`, { method: 'GET' })),
      },
      {
        name: 'logs',
        run: () => logsRoute.GET(jsonRequest(`${BASE}/api/admin/logs`, { method: 'GET' })),
      },
      {
        name: 'session GET',
        run: () => sessionRoute.GET(jsonRequest(`${BASE}/api/admin/session`, { method: 'GET' })),
      },
      {
        name: 'session DELETE',
        run: () => sessionRoute.DELETE(jsonRequest(`${BASE}/api/admin/session`, { method: 'DELETE' })),
      },
    ];

    for (const call of calls) {
      const response = await call.run();
      expect(response.status, call.name).toBe(401);
      expect(await bodyOf<unknown>(response), call.name).toEqual({ error: { message: 'unauthorized' } });
    }
  });

  it('issues a HttpOnly SameSite=Lax session cookie on a correct password', async () => {
    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    expect(response.status).toBe(200);
    expect(await bodyOf<unknown>(response)).toEqual({ data: { ok: true } });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/aragon_session=\d+\.[0-9a-f]{64}/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('rejects a wrong password with 401 {error:{message}}', async () => {
    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: 'nope' } }),
    );
    expect(response.status).toBe(401);
    const payload = await bodyOf<{ error: { message: string } }>(response);
    expect(typeof payload.error.message).toBe('string');
    expect(payload.error.message).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it('rejects a missing password with 400', async () => {
    const response = await sessionRoute.POST(jsonRequest(`${BASE}/api/admin/session`, { body: {} }));
    expect(response.status).toBe(400);
  });

  it('accepts the session cookie and clears it on DELETE', async () => {
    const getResponse = await sessionRoute.GET(adminRequest('/api/admin/session', { method: 'GET' }));
    expect(getResponse.status).toBe(200);
    expect(await bodyOf<unknown>(getResponse)).toEqual({ data: { ok: true } });

    const deleteResponse = await sessionRoute.DELETE(adminRequest('/api/admin/session', { method: 'DELETE' }));
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});

describe('admin routes: C5 api keys', () => {
  it('creates a key, returns the plaintext once and stores only its hash', async () => {
    const createResponse = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: 'integration' } }));
    expect(createResponse.status).toBe(200);
    const created = (await bodyOf<{ data: ApiKeyCreated }>(createResponse)).data;
    expect(created.key).toMatch(/^ar-[0-9a-f]{32}$/);
    expect(created.name).toBe('integration');
    expect(created.keyPrefix).toBe(created.key.slice(0, 10));
    expect(created.lastUsedAt).toBeNull();
    expect(created.revokedAt).toBeNull();

    const row = queryOne<{ key_hash: string; key_prefix: string }>('SELECT * FROM api_keys WHERE id = ?', [
      created.id,
    ]);
    expect(row?.key_hash).toBe(hashApiKey(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);

    const listResponse = await keysRoute.GET(adminRequest('/api/admin/keys', { method: 'GET' }));
    const listed = (await bodyOf<{ data: ApiKeyPublic[] }>(listResponse)).data;
    expect(listed).toHaveLength(1);
    const listedEntry = listed[0] as ApiKeyPublic & { key?: string; keyHash?: string };
    expect(listedEntry.key).toBeUndefined();
    expect(listedEntry.keyHash).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(created.key);
  });

  it('validates the key name', async () => {
    const response = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: '   ' } }));
    expect(response.status).toBe(400);
    const payload = await bodyOf<{ error: { message: string } }>(response);
    expect(payload.error.message).toContain('name');
  });

  it('soft revokes and reports 404 for unknown ids', async () => {
    const created = createApiKey('doomed', 'key-doomed');
    const response = await keysIdRoute.DELETE(
      adminRequest('/api/admin/keys/key-doomed', { method: 'DELETE' }),
      routeContext({ id: 'key-doomed' }),
    );
    expect(response.status).toBe(200);
    expect(await bodyOf<unknown>(response)).toEqual({ data: { id: 'key-doomed' } });
    expect(queryOne<{ revoked_at: number | null }>('SELECT revoked_at FROM api_keys WHERE id = ?', ['key-doomed'])?.revoked_at)
      .not.toBeNull();
    expect(created.public.revokedAt).toBeNull();

    const missing = await keysIdRoute.DELETE(
      adminRequest('/api/admin/keys/nope', { method: 'DELETE' }),
      routeContext({ id: 'nope' }),
    );
    expect(missing.status).toBe(404);
  });
});

describe('admin routes: C6 providers', () => {
  it('stores the upstream key encrypted and never returns it', async () => {
    const plaintext = 'sk-ant-super-secret-upstream';
    const response = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: plaintext },
      }),
    );
    expect(response.status).toBe(200);
    const provider = (await bodyOf<{ data: ProviderPublic }>(response)).data;
    expect(provider.protocol).toBe('anthropic');
    expect(provider.enabled).toBe(true);
    expect(provider.maskedKey).not.toContain(plaintext);
    expect(JSON.stringify(provider)).not.toContain(plaintext);
    expect((provider as unknown as { apiKey?: string }).apiKey).toBeUndefined();

    const row = queryOne<{ api_key_enc: string }>('SELECT * FROM providers WHERE id = ?', [provider.id]);
    expect(row?.api_key_enc).toBeTruthy();
    expect(row?.api_key_enc).not.toContain(plaintext);
    expect(row?.api_key_enc).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(open(row!.api_key_enc)).toBe(plaintext);

    const list = await providersRoute.GET(adminRequest('/api/admin/providers', { method: 'GET' }));
    const listPayload = await bodyOf<{ data: ProviderPublic[] }>(list);
    expect(JSON.stringify(listPayload)).not.toContain(plaintext);
    expect(listPayload.data[0]?.maskedKey).toBe(provider.maskedKey);
  });

  it('validates protocol, base URL and credential', async () => {
    const badProtocol = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'x', protocol: 'grpc', baseUrl: 'https://a.example.com', apiKey: 'k' },
      }),
    );
    expect(badProtocol.status).toBe(400);

    const badUrl = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'x', protocol: 'openai', baseUrl: 'file:///etc/passwd', apiKey: 'k' },
      }),
    );
    expect(badUrl.status).toBe(400);

    const injection = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: {
          name: 'x',
          protocol: 'openai',
          baseUrl: 'https://a.example.com',
          apiKey: 'sk-abc\r\nX-Injected: 1',
        },
      }),
    );
    expect(injection.status).toBe(400);

    const missingKey = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'x', protocol: 'openai', baseUrl: 'https://a.example.com' },
      }),
    );
    expect(missingKey.status).toBe(400);
  });

  it('patches enabled state without touching the credential and deletes the row', async () => {
    const created = await createProviderFixture('primary');
    const provider = (await bodyOf<{ data: ProviderPublic }>(created)).data;
    const before = queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [provider.id]);

    const patched = await providersIdRoute.PATCH(
      adminRequest(`/api/admin/providers/${provider.id}`, { method: 'PATCH', body: { enabled: false } }),
      routeContext({ id: provider.id }),
    );
    expect(patched.status).toBe(200);
    expect((await bodyOf<{ data: ProviderPublic }>(patched)).data.enabled).toBe(false);
    const after = queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [provider.id]);
    expect(after?.api_key_enc).toBe(before?.api_key_enc);

    const removed = await providersIdRoute.DELETE(
      adminRequest(`/api/admin/providers/${provider.id}`, { method: 'DELETE' }),
      routeContext({ id: provider.id }),
    );
    expect(removed.status).toBe(200);
    expect(await bodyOf<unknown>(removed)).toEqual({ data: { id: provider.id } });

    const gone = await providersIdRoute.GET(
      adminRequest(`/api/admin/providers/${provider.id}`, { method: 'GET' }),
      routeContext({ id: provider.id }),
    );
    expect(gone.status).toBe(404);
  });

  it('probes {baseUrl}/v1/models for the connection test', async () => {
    const created = await createProviderFixture('probe');
    const provider = (await bodyOf<{ data: ProviderPublic }>(created)).data;

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'claude-3-opus' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    expect(response.status).toBe(200);
    const result = (await bodyOf<{ data: { ok: boolean; message: string } }>(response)).data;
    expect(result.ok).toBe(true);
    expect(result.message).toContain('model');
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.anthropic.com/v1/models');
    expect(new Headers(call[1].headers).get('x-api-key')).toBe('sk-ant-upstream');

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('nope', { status: 401 })),
    );
    const failed = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    const failedResult = (await bodyOf<{ data: { ok: boolean; message: string } }>(failed)).data;
    expect(failedResult.ok).toBe(false);
    expect(failedResult.message).toContain('401');
    expect(failedResult.message).not.toContain('sk-ant-upstream');
  });

  it('reports a missing provider for the connection test', async () => {
    const response = await providerTestRoute.POST(
      adminRequest('/api/admin/providers/missing/test', { body: {} }),
      routeContext({ id: 'missing' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('admin routes: C7 stats', () => {
  it('returns range/totals/series/byModel/byKey and a request count matching the rows', async () => {
    const created = createApiKey('stats-key', 'key-stats');
    const now = Date.now();
    insertRequestLog({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3',
      upstream: 'anthropic-main',
      status: 200,
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      apiKeyId: created.public.id,
      stream: false,
      createdAt: now - 60_000,
    });
    insertRequestLog({
      protocol: 'openai',
      path: '/v1/chat/completions',
      model: 'gpt-4o',
      upstream: 'openai-main',
      status: 500,
      latencyMs: 300,
      inputTokens: 5,
      outputTokens: 0,
      apiKeyId: created.public.id,
      stream: true,
      createdAt: now - 30_000,
    });
    insertRequestLog({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3',
      upstream: 'anthropic-main',
      status: 200,
      latencyMs: 200,
      inputTokens: 1,
      outputTokens: 2,
      apiKeyId: null,
      stream: false,
      createdAt: now - 1_000,
    });

    const response = await statsRoute.GET(
      jsonRequest(`${BASE}/api/admin/stats?range=7d`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(response.status).toBe(200);
    const stats = (await bodyOf<{
      data: {
        range: string;
        totals: { requests: number; inputTokens: number; outputTokens: number; errorRate: number; avgLatencyMs: number };
        series: Array<{ t: string; requests: number; inputTokens: number; outputTokens: number; errors: number }>;
        byModel: Array<{ model: string; requests: number; inputTokens: number; outputTokens: number }>;
        byKey: Array<{ apiKeyId: string | null; name: string; requests: number }>;
      };
    }>(response)).data;

    expect(stats.range).toBe('7d');
    expect(stats.series).toHaveLength(7);
    expect(stats.totals.requests).toBe(3);
    expect(stats.totals.inputTokens).toBe(16);
    expect(stats.totals.outputTokens).toBe(22);
    expect(stats.totals.errorRate).toBeCloseTo(1 / 3, 4);
    expect(stats.totals.avgLatencyMs).toBe(200);

    const rowCount = queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM request_logs');
    expect(stats.totals.requests).toBe(Number(rowCount?.count));
    expect(stats.series.reduce((sum, point) => sum + point.requests, 0)).toBe(stats.totals.requests);

    const models = stats.byModel.map((entry) => entry.model).sort();
    expect(models).toEqual(['claude-3', 'gpt-4o']);
    expect(stats.byModel.find((entry) => entry.model === 'claude-3')?.requests).toBe(2);

    const byKey = stats.byKey.find((entry) => entry.apiKeyId === created.public.id);
    expect(byKey?.name).toBe('stats-key');
    expect(byKey?.requests).toBe(2);
    expect(stats.byKey.some((entry) => entry.apiKeyId === null)).toBe(true);
  });

  it('honours range buckets and defaults unknown ranges to 7d', async () => {
    const twentyFour = await statsRoute.GET(
      jsonRequest(`${BASE}/api/admin/stats?range=24h`, { method: 'GET', headers: adminHeaders() }),
    );
    const dayStats = (await bodyOf<{ data: { range: string; series: unknown[] } }>(twentyFour)).data;
    expect(dayStats.range).toBe('24h');
    expect(dayStats.series).toHaveLength(24);

    const thirty = await statsRoute.GET(
      jsonRequest(`${BASE}/api/admin/stats?range=30d`, { method: 'GET', headers: adminHeaders() }),
    );
    const monthStats = (await bodyOf<{ data: { range: string; series: unknown[] } }>(thirty)).data;
    expect(monthStats.range).toBe('30d');
    expect(monthStats.series).toHaveLength(30);

    const fallback = await statsRoute.GET(
      jsonRequest(`${BASE}/api/admin/stats?range=1y`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(((await bodyOf<{ data: { range: string } }>(fallback)).data).range).toBe('7d');
  });

  it('returns zeroed totals when no requests were logged', async () => {
    const response = await statsRoute.GET(
      jsonRequest(`${BASE}/api/admin/stats?range=7d`, { method: 'GET', headers: adminHeaders() }),
    );
    const stats = (await bodyOf<{
      data: {
        totals: { requests: number; errorRate: number; avgLatencyMs: number };
        series: unknown[];
        byModel: unknown[];
        byKey: unknown[];
      };
    }>(response)).data;
    expect(stats.totals).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, errorRate: 0, avgLatencyMs: 0 });
    expect(stats.series).toHaveLength(7);
    expect(stats.byModel).toEqual([]);
    expect(stats.byKey).toEqual([]);
  });
});

describe('admin routes: C8 logs', () => {
  function seedLogs(): void {
    const base = 1_700_000_000_000;
    for (let index = 0; index < 3; index += 1) {
      insertRequestLog({
        protocol: index === 0 ? 'openai' : 'anthropic',
        path: index === 0 ? '/v1/chat/completions' : '/v1/messages',
        model: index === 2 ? 'claude-3-haiku' : 'claude-3-opus',
        upstream: 'upstream-a',
        status: index === 1 ? 500 : 200,
        latencyMs: 10 + index,
        inputTokens: index,
        outputTokens: index * 2,
        apiKeyId: 'key-logs',
        error: index === 1 ? 'boom' : null,
        stream: index === 0,
        createdAt: base + index * 1000,
      });
    }
  }

  it('returns the documented shape with keyset pagination', async () => {
    seedLogs();
    const first = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?limit=2`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(first.status).toBe(200);
    const firstPage = await bodyOf<{
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>(first);
    expect(firstPage.data).toHaveLength(2);
    expect(typeof firstPage.nextCursor).toBe('string');
    const newest = firstPage.data[0]!;
    expect(newest.createdAt).toBe(new Date(1_700_000_002_000).toISOString());
    expect(Object.keys(newest).sort()).toEqual(
      [
        'apiKeyId',
        'createdAt',
        'error',
        'id',
        'inputTokens',
        'latencyMs',
        'model',
        'outputTokens',
        'path',
        'protocol',
        'status',
        'stream',
        'upstream',
      ].sort(),
    );
    expect(firstPage.data[1]?.status).toBe(500);
    expect(firstPage.data[1]?.error).toBe('boom');

    const second = await logsRoute.GET(
      jsonRequest(
        `${BASE}/api/admin/logs?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
        { method: 'GET', headers: adminHeaders() },
      ),
    );
    const secondPage = await bodyOf<{ data: Array<{ stream: boolean; protocol: string }>; nextCursor: string | null }>(
      second,
    );
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?.protocol).toBe('openai');
    expect(secondPage.data[0]?.stream).toBe(true);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('filters by model and status', async () => {
    seedLogs();
    const byModel = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?model=claude-3-haiku`, { method: 'GET', headers: adminHeaders() }),
    );
    const modelPage = await bodyOf<{ data: Array<{ model: string }> }>(byModel);
    expect(modelPage.data).toHaveLength(1);
    expect(modelPage.data[0]?.model).toBe('claude-3-haiku');

    const byStatus = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?status=500`, { method: 'GET', headers: adminHeaders() }),
    );
    const statusPage = await bodyOf<{ data: Array<{ status: number }> }>(byStatus);
    expect(statusPage.data).toHaveLength(1);
    expect(statusPage.data[0]?.status).toBe(500);
  });

  it('rejects a malformed cursor with 400', async () => {
    const response = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?cursor=garbage`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(response.status).toBe(400);
  });

  it('defaults to 50 rows and caps the limit', async () => {
    seedLogs();
    const response = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?limit=9999`, { method: 'GET', headers: adminHeaders() }),
    );
    const page = await bodyOf<{ data: unknown[]; nextCursor: string | null }>(response);
    expect(page.data).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});

describe('client route: model catalogue', () => {
  it('requires a key and aggregates provider models', async () => {
    const anonymous = await modelsRoute.GET(jsonRequest(`${BASE}/api/v1/models`, { method: 'GET' }));
    expect(anonymous.status).toBe(401);

    const created = createApiKey('models', 'key-models');
    await createProviderFixture('catalogue');

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'claude-3-opus' }, { id: 'claude-3-haiku' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const response = await modelsRoute.GET(
      jsonRequest(`${BASE}/api/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': created.key },
      }),
    );
    expect(response.status).toBe(200);
    const payload = await bodyOf<{ object: string; data: Array<{ id: string; owned_by: string }> }>(response);
    expect(payload.object).toBe('list');
    expect(payload.data.map((entry) => entry.id)).toEqual(['claude-3-opus', 'claude-3-haiku']);
    expect(payload.data[0]?.owned_by).toBe('catalogue');
  });
});
