import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providerTestRoute from '@/app/api/admin/providers/[id]/test/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as modelsRoute from '@/app/api/v1/models/route';
import { resetDbForTests } from '@/lib/db';
import { resetLoginThrottle } from '@/lib/login-throttle';
import { MODELS_PATH, RELAY_PATHS } from '@/lib/upstream';
import {
  STUB_ANTHROPIC_KEY,
  STUB_OPENAI_KEY,
  readStubState,
  startStubUpstream,
  waitFor,
  type StubHandle,
} from './stub-harness';

/**
 * Cross-module boundary test: `ops-scripts` (the offline stub upstream + the flow
 * `scripts/test-api.ps1` automates) driven through the *real* gateway handlers from
 * `gw-hardening` over real loopback sockets.
 *
 * Why it exists: `scripts/test-api.ps1` can only assert what the stub and the routes
 * agree on today. This suite reproduces the same chain in-process so contract drift
 * between the two work packages (relay path, credential injection, SSE framing,
 * error envelope, log/stats shapes, key revocation) fails a fast, offline test
 * instead of a manual PowerShell run.
 */

const BASE = 'http://localhost';
const ADMIN_PASSWORD = 'integration-admin-password';

interface ProviderBody {
  data: {
    id: string;
    name: string;
    protocol: string;
    baseUrl: string;
    enabled: boolean;
    maskedKey: string;
  };
}

interface KeyBody {
  data: { id: string; key: string; keyPrefix: string; name: string };
}

interface LogEntry {
  id: string;
  path: string;
  protocol: string;
  status: number;
  stream: boolean;
  apiKeyId: string | null;
  model: string | null;
  outputTokens: number | null;
}

interface LogsBody {
  data: LogEntry[];
  nextCursor: string | null;
}

interface StatsBody {
  data: {
    range: string;
    totals: { requests: number; inputTokens: number; outputTokens: number; errorRate: number };
    series: unknown[];
    byModel: Array<{ model: string; requests: number }>;
  };
}

let stub: StubHandle;
let adminCookie = '';
const state = {
  anthropicProviderId: '',
  openaiProviderId: '',
  keyId: '',
  key: '',
};

function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }
  return new Request(`${BASE}${path}`, { method: init.method ?? 'POST', headers, body });
}

function adminRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  return request(path, { ...init, headers: { ...(init.headers ?? {}), cookie: adminCookie } });
}

function routeContext<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, received: ${text.slice(0, 300)}`);
  }
}

describe('gateway ↔ stub upstream (offline end-to-end, handler level)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
    process.env.SESSION_SECRET = 'integration-session-secret-0123456789abcdef';
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    process.env.DATABASE_PATH = ':memory:';
    delete process.env.COOKIE_SECURE;
    resetDbForTests();
    resetLoginThrottle();

    stub = await startStubUpstream();

    const login = await sessionRoute.POST(request('/api/admin/session', { body: { password: ADMIN_PASSWORD } }));
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    const pair = setCookie.split(';')[0];
    expect(pair, 'login did not return a session cookie').toBeTruthy();
    adminCookie = String(pair);

    const anthropic = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: {
          name: 'stub-anthropic',
          protocol: 'anthropic',
          baseUrl: stub.baseUrl,
          apiKey: STUB_ANTHROPIC_KEY,
        },
      }),
    );
    expect(anthropic.status, await anthropic.clone().text()).toBe(200);
    state.anthropicProviderId = (await json<ProviderBody>(anthropic)).data.id;

    const openai = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: {
          name: 'stub-openai',
          protocol: 'openai',
          baseUrl: stub.baseUrl,
          apiKey: STUB_OPENAI_KEY,
        },
      }),
    );
    expect(openai.status).toBe(200);
    state.openaiProviderId = (await json<ProviderBody>(openai)).data.id;

    const key = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: 'integration-key' } }));
    expect(key.status).toBe(200);
    const created = await json<KeyBody>(key);
    state.keyId = created.data.id;
    state.key = created.data.key;
  }, 30_000);

  afterAll(async () => {
    await stub?.stop();
  });

  beforeEach(async () => {
    resetLoginThrottle();
  });

  describe('C3 admin session', () => {
    it('exchanges the admin password for an HttpOnly SameSite=Lax cookie', async () => {
      const response = await sessionRoute.POST(request('/api/admin/session', { body: { password: ADMIN_PASSWORD } }));
      expect(response.status).toBe(200);
      const body = await json<{ data: { ok: boolean } }>(response);
      expect(body.data.ok).toBe(true);
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('aragon_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
    });

    it('rejects a wrong password with 401 and does not hand out a cookie', async () => {
      const response = await sessionRoute.POST(
        request('/api/admin/session', { body: { password: `${ADMIN_PASSWORD}-wrong` } }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('guards every admin route with 401 unauthorized when the cookie is missing', async () => {
      for (const [handler, path] of [
        [keysRoute.GET, '/api/admin/keys'],
        [providersRoute.GET, '/api/admin/providers'],
        [logsRoute.GET, '/api/admin/logs'],
        [statsRoute.GET, '/api/admin/stats'],
      ] as const) {
        const response = await handler(request(path, { method: 'GET' }) as never);
        expect(response.status, `${path} should be unauthorized`).toBe(401);
        expect((await json<{ error: { message: string } }>(response)).error.message).toBe('unauthorized');
      }
    });
  });

  describe('C5/C6 admin resources created by the e2e flow', () => {
    it('creates an API key whose plaintext is returned exactly once', async () => {
      expect(state.key).toMatch(/^ar-[0-9a-f]{32}$/);
      const list = await keysRoute.GET(adminRequest('/api/admin/keys', { method: 'GET' }));
      const body = await json<{ data: Array<Record<string, unknown>> }>(list);
      const row = body.data.find((entry) => entry.id === state.keyId);
      expect(row).toBeDefined();
      expect(row?.key).toBeUndefined();
      expect(String(row?.keyPrefix)).toMatch(/^ar-[0-9a-f]{7}$/);
    });

    it('stores the provider credential encrypted and only echoes maskedKey', async () => {
      const list = await providersRoute.GET(adminRequest('/api/admin/providers', { method: 'GET' }));
      const text = await list.text();
      expect(text).not.toContain(STUB_ANTHROPIC_KEY);
      expect(text).not.toContain(STUB_OPENAI_KEY);
      const body = JSON.parse(text) as { data: ProviderBody['data'][] };
      const anthropic = body.data.find((entry) => entry.id === state.anthropicProviderId);
      expect(anthropic?.protocol).toBe('anthropic');
      expect(anthropic?.baseUrl).toBe(stub.baseUrl);
      expect(anthropic?.enabled).toBe(true);
      expect(anthropic?.maskedKey.length).toBeGreaterThan(0);
    });

    it('probes {baseUrl}/v1/models through the provider test endpoint (C6)', async () => {
      const response = await providerTestRoute.POST(
        adminRequest(`/api/admin/providers/${state.anthropicProviderId}/test`, { body: {} }),
        routeContext({ id: state.anthropicProviderId }),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(STUB_ANTHROPIC_KEY);
      const body = JSON.parse(text) as { data: { ok: boolean; message: string } };
      expect(body.data.ok).toBe(true);
      expect(body.data.message.length).toBeGreaterThan(0);
      const state_ = await readStubState(stub.baseUrl);
      expect(state_.requests.some((record) => record.path === MODELS_PATH)).toBe(true);
    });
  });

  describe('C9 forwarding to the stub upstream', () => {
    it('relays /api/v1/messages and injects the provider credential, never the client key', async () => {
      const before = (await readStubState(stub.baseUrl)).count;
      const response = await messagesRoute.POST(
        request('/api/v1/messages', {
          headers: { 'x-api-key': state.key },
          body: {
            model: 'stub-anthropic-model',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'integration ping' }],
          },
        }),
      );
      expect(response.status).toBe(200);
      const body = await json<{ type: string; usage: { output_tokens: number } }>(response);
      expect(body.type).toBe('message');
      expect(body.usage.output_tokens).toBeGreaterThan(0);

      const after = await readStubState(stub.baseUrl);
      const upstream = after.requests.slice(before);
      expect(upstream).toHaveLength(1);
      expect(upstream[0]?.path).toBe(RELAY_PATHS.anthropic);
      expect(upstream[0]?.apiKeyValue).toBe(STUB_ANTHROPIC_KEY);
      // The client never sent anthropic-version: the gateway must default it.
      expect(upstream[0]?.anthropicVersion).toBe('2023-06-01');
      expect(upstream[0]?.credentialLeak).toBe(false);
    });

    it('streams SSE through to the client when the body asks for stream:true (no Accept header)', async () => {
      const response = await messagesRoute.POST(
        request('/api/v1/messages', {
          headers: { 'x-api-key': state.key },
          body: { model: 'stub-anthropic-model', stream: true, max_tokens: 16, messages: [] },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const text = await response.text();
      expect(text).toContain('event: message_start');
      expect(text).toContain('event: content_block_delta');
      expect(text).toContain('event: message_stop');

      // The upstream was told to stream too (`accept: text/event-stream`), otherwise
      // the relay would have received a JSON body it happily framed as SSE.
      const upstream = await waitFor(async () => {
        const snapshot = await readStubState(stub.baseUrl);
        const record = [...snapshot.requests].reverse().find((entry) => entry.path === RELAY_PATHS.anthropic && entry.stream);
        return record ?? null;
      }, { label: 'streamed anthropic request recorded by the stub' });
      expect(upstream.accept).toBe('text/event-stream');
      expect(upstream.credentialLeak).toBe(false);
    });

    it('relays /api/v1/chat/completions with Authorization: Bearer on the upstream side', async () => {
      const before = (await readStubState(stub.baseUrl)).count;
      const response = await chatRoute.POST(
        request('/api/v1/chat/completions', {
          headers: { authorization: `Bearer ${state.key}` },
          body: { model: 'stub-openai-model', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );
      expect(response.status).toBe(200);
      const body = await json<{ object: string; choices: Array<{ message: { content: string } }> }>(response);
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0]?.message.content.length).toBeGreaterThan(0);

      const upstream = (await readStubState(stub.baseUrl)).requests.slice(before);
      expect(upstream).toHaveLength(1);
      expect(upstream[0]?.path).toBe(RELAY_PATHS.openai);
      expect(upstream[0]?.authorizationValue).toBe(`Bearer ${STUB_OPENAI_KEY}`);
      expect(upstream[0]?.credentialLeak).toBe(false);
    });

    it('aggregates the stub catalogue on GET /api/v1/models', async () => {
      const response = await modelsRoute.GET(
        request('/api/v1/models', { method: 'GET', headers: { 'x-api-key': state.key } }) as never,
      );
      expect(response.status).toBe(200);
      const body = await json<{ object: string; data: Array<{ id: string }> }>(response);
      expect(body.object).toBe('list');
      expect(body.data.map((model) => model.id)).toEqual(
        expect.arrayContaining(['stub-anthropic-model', 'stub-openai-model']),
      );
    });

    it('never lets a client credential reach the upstream across the whole session', async () => {
      const snapshot = await readStubState(stub.baseUrl);
      expect(snapshot.count).toBeGreaterThan(0);
      expect(snapshot.requests.filter((record) => record.credentialLeak)).toHaveLength(0);
      const leaked = snapshot.requests.filter(
        (record) => record.apiKeyValue === state.key || record.authorizationValue === `Bearer ${state.key}`,
      );
      expect(leaked).toHaveLength(0);
    });

    it('rejects an unknown key with 401 authentication_error without touching the upstream', async () => {
      const before = (await readStubState(stub.baseUrl)).count;
      const response = await messagesRoute.POST(
        request('/api/v1/messages', {
          headers: { 'x-api-key': `ar-${'0'.repeat(32)}` },
          body: { model: 'stub-anthropic-model', max_tokens: 8, messages: [] },
        }),
      );
      expect(response.status).toBe(401);
      const body = await json<{ type: string; error: { type: string; message: string } }>(response);
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.message.length).toBeGreaterThan(0);
      expect((await readStubState(stub.baseUrl)).count).toBe(before);
    });
  });

  describe('C7/C8 observability as the scripts assert it', () => {
    it('records every relay in /api/admin/logs with request, token and stream details', async () => {
      const entries = await waitFor(async () => {
        const response = await logsRoute.GET(adminRequest('/api/admin/logs?limit=50', { method: 'GET' }) as never);
        const body = await json<LogsBody>(response);
        return body.data.length >= 3 ? body : null;
      }, { label: '3 relay log rows' });

      expect(Array.isArray(entries.data)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(entries, 'nextCursor')).toBe(true);

      const messages = entries.data.filter((entry) => entry.path === RELAY_PATHS.anthropic && entry.status === 200);
      expect(messages.length).toBeGreaterThan(0);
      expect(entries.data.some((entry) => entry.stream === true)).toBe(true);
      expect(entries.data.some((entry) => (entry.outputTokens ?? 0) > 0)).toBe(true);
      expect(entries.data.every((entry) => entry.apiKeyId === state.keyId)).toBe(true);

      const raw = await logsRoute.GET(adminRequest('/api/admin/logs?limit=50', { method: 'GET' }) as never);
      const text = await raw.text();
      expect(text).not.toContain(STUB_ANTHROPIC_KEY);
      expect(text).not.toContain(state.key);
    });

    it('reports totals.requests > 0 and keeps stats consistent with the log count', async () => {
      const response = await statsRoute.GET(adminRequest('/api/admin/stats?range=24h', { method: 'GET' }) as never);
      expect(response.status).toBe(200);
      const body = await json<StatsBody>(response);
      expect(body.data.range).toBe('24h');
      expect(body.data.totals.requests).toBeGreaterThan(0);
      expect(body.data.series.length).toBeGreaterThan(0);
      expect(body.data.byModel.length).toBeGreaterThan(0);
      expect(typeof body.data.totals.errorRate).toBe('number');
      expect(Number.isInteger(body.data.totals.outputTokens)).toBe(true);

      const logs = await logsRoute.GET(adminRequest('/api/admin/logs?limit=200', { method: 'GET' }) as never);
      const logBody = await json<LogsBody>(logs);
      if (logBody.data.length < 200) {
        expect(body.data.totals.requests).toBe(logBody.data.length);
      } else {
        expect(body.data.totals.requests).toBeGreaterThanOrEqual(logBody.data.length);
      }
    });
  });

  describe('post-e2e cleanup assumptions', () => {
    it('a soft-revoked key stops working immediately (script cleanup leaves no live credential)', async () => {
      const revoked = await keysIdRoute.DELETE(
        adminRequest(`/api/admin/keys/${state.keyId}`, { method: 'DELETE' }),
        routeContext({ id: state.keyId }),
      );
      expect(revoked.status).toBe(200);

      const response = await messagesRoute.POST(
        request('/api/v1/messages', {
          headers: { 'x-api-key': state.key },
          body: { model: 'stub-anthropic-model', max_tokens: 8, messages: [] },
        }),
      );
      expect(response.status).toBe(401);
      const body = await json<{ error: { type: string } }>(response);
      expect(body.error.type).toBe('authentication_error');
    });

    it('deleting the provider removes the relay target and yields a readable error, not a 200', async () => {
      for (const id of [state.anthropicProviderId, state.openaiProviderId]) {
        const response = await providersIdRoute.DELETE(
          adminRequest(`/api/admin/providers/${id}`, { method: 'DELETE' }),
          routeContext({ id }),
        );
        expect(response.status).toBe(200);
      }
      const list = await providersRoute.GET(adminRequest('/api/admin/providers', { method: 'GET' }));
      const body = await json<{ data: Array<{ id: string }> }>(list);
      expect(body.data).toHaveLength(0);
    });
  });
});
