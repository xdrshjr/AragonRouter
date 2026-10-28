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
import { SESSION_COOKIE, createSessionToken } from '@/lib/auth';
import { createApiKey } from '@/lib/apikeys';
import { hmacSha256Hex } from '@/lib/crypto';
import { queryAll } from '@/lib/db';
import { createProvider } from '@/lib/providers';
import { relay } from '@/lib/proxy';
import type { ProviderPublic } from '@/lib/types';
import {
  TEST_ADMIN_PASSWORD,
  TEST_SESSION_SECRET,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
  routeContext,
} from './test-helpers';

/**
 * Hostile-input and credential-confusion tests.
 *
 * Fills the gaps the per-module suites leave: the three admin routes that were
 * missing from the "everything is 401" matrix, forged/expired session cookies,
 * client API keys presented as admin or as query parameters, envelope conformance
 * (C3/C4/C2), and the input validation of the two admin write surfaces.
 * Offline: fetch is stubbed wherever a relay or a probe is involved.
 */

const BASE = 'http://localhost';

function adminRequest(path: string, init: Parameters<typeof jsonRequest>[1] = {}): Request {
  return jsonRequest(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...adminHeaders() },
  });
}

function forgeToken(expiresAt: number, secret = TEST_SESSION_SECRET): string {
  const payload = String(expiresAt);
  return `${payload}.${hmacSha256Hex(secret, payload)}`;
}

function anthropicProvider(apiKey = 'sk-ant-upstream-secret') {
  return createProvider({
    name: 'anthropic-main',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey,
  });
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin auth: complete 401 matrix (C3)', () => {
  it('rejects the admin routes that the per-module suite never covered', async () => {
    const calls: Array<{ name: string; run: () => Promise<Response> }> = [
      {
        name: 'GET keys/[id]',
        run: () =>
          keysIdRoute.GET(jsonRequest(`${BASE}/api/admin/keys/x`, { method: 'GET' }), routeContext({ id: 'x' })),
      },
      {
        name: 'GET providers/[id]',
        run: () =>
          providersIdRoute.GET(
            jsonRequest(`${BASE}/api/admin/providers/x`, { method: 'GET' }),
            routeContext({ id: 'x' }),
          ),
      },
      {
        name: 'DELETE providers/[id]',
        run: () =>
          providersIdRoute.DELETE(
            jsonRequest(`${BASE}/api/admin/providers/x`, { method: 'DELETE' }),
            routeContext({ id: 'x' }),
          ),
      },
    ];

    for (const call of calls) {
      const response = await call.run();
      expect(response.status, call.name).toBe(401);
      expect(await readJson(response), call.name).toEqual({ error: { message: 'unauthorized' } });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects forged, legacy, expired and truncated session cookies', async () => {
    createApiKey('cookie-target', 'key-cookie');
    const forged = [
      '',
      'garbage',
      'abc.def',
      `${Date.now()}.${'0'.repeat(64)}`,
      forgeToken(Date.now() - 1_000), // legacy HMAC token: no longer a credential
      forgeToken(Date.now() + 60_000, 'a-different-signing-secret-of-32-chars'),
      `${Date.now() + 60_000}.${'a'.repeat(64)}.extra`,
      `${'9'.repeat(20)}.${'a'.repeat(64)}`,
    ];

    for (const token of forged) {
      const response = await keysRoute.GET(
        new Request(`${BASE}/api/admin/keys`, { method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      );
      expect(response.status, token).toBe(401);
      expect(await readJson(response), token).toEqual({ error: { message: 'unauthorized' } });
    }

    // Only a real database session is accepted, even though it has the same
    // `<sessionId>.<secret>` shape as the legacy signed tokens above.
    const valid = await keysRoute.GET(
      new Request(`${BASE}/api/admin/keys`, {
        method: 'GET',
        headers: { cookie: `${SESSION_COOKIE}=${createSessionToken(Date.now())}` },
      }),
    );
    expect(valid.status).toBe(200);
  });

  it('does not accept a client API key as an admin credential', async () => {
    const created = createApiKey('confusion', 'key-confusion');
    const viaBearer = await keysRoute.GET(
      new Request(`${BASE}/api/admin/keys`, {
        method: 'GET',
        headers: { authorization: `Bearer ${created.key}` },
      }),
    );
    expect(viaBearer.status).toBe(401);

    const viaCookie = await keysRoute.GET(
      new Request(`${BASE}/api/admin/keys`, {
        method: 'GET',
        headers: { cookie: `${SESSION_COOKIE}=${created.key}` },
      }),
    );
    expect(viaCookie.status).toBe(401);
    // Nothing was revoked or created by the failed attempts.
    expect(queryAll('SELECT id FROM api_keys')).toHaveLength(1);
  });

  it('keeps the session cookie out of the body and the password out of the cookie', async () => {
    const ok = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    const body = await ok.text();
    expect(body).not.toContain(TEST_ADMIN_PASSWORD);
    expect(body).not.toContain('aragon_session');
    expect(ok.headers.get('set-cookie') ?? '').not.toContain(TEST_ADMIN_PASSWORD);

    const bad = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: 'wrong-password-value' } }),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const badBody = await bad.text();
    expect(badBody).not.toContain('wrong-password-value');
    expect(badBody).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it('fails closed when the admin password is not configured', async () => {
    delete process.env.ADMIN_PASSWORD;
    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: 'anything' } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('client auth: credential confusion (C2)', () => {
  it('ignores credentials smuggled in the query string', async () => {
    const created = createApiKey('query-key', 'key-query');
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await messagesRoute.POST(
      new Request(`${BASE}/api/v1/messages?x-api-key=${encodeURIComponent(created.key)}&api_key=${encodeURIComponent(created.key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is case sensitive and rejects malformed or oversized credentials', async () => {
    const created = createApiKey('exact-key', 'key-exact');
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ model: 'claude-3' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const rejected = [
      created.key.toUpperCase(),
      created.key.slice(0, -1),
      `${created.key}0`,
      created.key.slice(1),
      'ar-',
      'ar-zzzz',
      `ar-${'0'.repeat(32)}`,
      `Bearer ${created.key}`,
      `ar-${created.key}`,
      'x'.repeat(10_000),
    ];
    for (const candidate of rejected) {
      const response = await messagesRoute.POST(
        jsonRequest(`${BASE}/api/v1/messages`, {
          body: { model: 'claude-3', messages: [] },
          headers: { 'x-api-key': candidate },
        }),
      );
      expect(response.status, candidate.slice(0, 20)).toBe(401);
      expect((await readJson<{ error: { type: string } }>(response)).error.type).toBe('authentication_error');
    }

    // Surrounding whitespace is an HTTP transport artefact, not a second credential:
    // the value must still match the stored hash exactly once trimmed.
    for (const candidate of [`  ${created.key}  `, `\t${created.key}`]) {
      const response = await messagesRoute.POST(
        jsonRequest(`${BASE}/api/v1/messages`, {
          body: { model: 'claude-3', messages: [] },
          headers: { 'x-api-key': candidate },
        }),
      );
      expect(response.status, 'padded key').toBe(200);
      await response.text();
    }
  });
});

describe('envelopes: C4 / C3 / C2 conformance', () => {
  it('wraps every admin success in {data} and every admin failure in {error:{message}}', async () => {
    const created = createApiKey('envelope', 'key-envelope');
    const provider = anthropicProvider();

    const successes: Array<{ name: string; response: Response; list?: boolean }> = [
      { name: 'keys list', response: await keysRoute.GET(adminRequest('/api/admin/keys', { method: 'GET' })), list: true },
      { name: 'keys create', response: await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: 'n' } })) },
      {
        name: 'key read',
        response: await keysIdRoute.GET(
          adminRequest('/api/admin/keys/key-envelope', { method: 'GET' }),
          routeContext({ id: 'key-envelope' }),
        ),
      },
      {
        name: 'key revoke',
        response: await keysIdRoute.DELETE(
          adminRequest(`/api/admin/keys/${created.public.id}`, { method: 'DELETE' }),
          routeContext({ id: created.public.id }),
        ),
      },
      { name: 'providers list', response: await providersRoute.GET(adminRequest('/api/admin/providers', { method: 'GET' })), list: true },
      {
        name: 'provider read',
        response: await providersIdRoute.GET(
          adminRequest(`/api/admin/providers/${provider.id}`, { method: 'GET' }),
          routeContext({ id: provider.id }),
        ),
      },
      { name: 'stats', response: await statsRoute.GET(adminRequest('/api/admin/stats?range=7d', { method: 'GET' })) },
      { name: 'logs', response: await logsRoute.GET(adminRequest('/api/admin/logs', { method: 'GET' })), list: true },
      { name: 'session probe', response: await sessionRoute.GET(adminRequest('/api/admin/session', { method: 'GET' })) },
    ];

    for (const entry of successes) {
      expect(entry.response.status, entry.name).toBe(200);
      const payload = await readJson<Record<string, unknown>>(entry.response);
      const keys = Object.keys(payload).sort();
      if (entry.list) {
        // C4: a list is `{data:[...], nextCursor?: string|null}` - only the log
        // endpoint (C8) is required to always carry `nextCursor`.
        expect(keys, entry.name).toEqual(expect.arrayContaining(['data']));
        expect(keys.filter((key) => key !== 'data' && key !== 'nextCursor'), entry.name).toEqual([]);
        expect(Array.isArray(payload.data), entry.name).toBe(true);
        if (payload.nextCursor !== undefined) {
          expect(payload.nextCursor === null || typeof payload.nextCursor === 'string', entry.name).toBe(true);
        }
      } else {
        expect(keys, entry.name).toEqual(['data']);
      }
    }

    // C8 pins the shape of the log list: nextCursor is always present.
    const logs = await readJson<Record<string, unknown>>(
      await logsRoute.GET(adminRequest('/api/admin/logs', { method: 'GET' })),
    );
    expect(Object.keys(logs).sort()).toEqual(['data', 'nextCursor']);
    expect(logs.nextCursor).toBeNull();

    const failures: Array<{ name: string; response: Response; status: number }> = [
      {
        name: 'unknown key',
        response: await keysIdRoute.GET(
          adminRequest('/api/admin/keys/missing', { method: 'GET' }),
          routeContext({ id: 'missing' }),
        ),
        status: 404,
      },
      {
        name: 'unknown provider',
        response: await providersIdRoute.DELETE(
          adminRequest('/api/admin/providers/missing', { method: 'DELETE' }),
          routeContext({ id: 'missing' }),
        ),
        status: 404,
      },
      {
        name: 'bad key name',
        response: await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: '' } })),
        status: 400,
      },
      {
        name: 'bad cursor',
        response: await logsRoute.GET(adminRequest('/api/admin/logs?cursor=nope', { method: 'GET' })),
        status: 400,
      },
      {
        name: 'unauthorized',
        response: await statsRoute.GET(jsonRequest(`${BASE}/api/admin/stats`, { method: 'GET' })),
        status: 401,
      },
    ];

    for (const entry of failures) {
      expect(entry.response.status, entry.name).toBe(entry.status);
      const payload = await readJson<Record<string, unknown>>(entry.response);
      expect(Object.keys(payload), entry.name).toEqual(['error']);
      const error = payload.error as Record<string, unknown>;
      expect(Object.keys(error), entry.name).toEqual(['message']);
      expect(typeof error.message, entry.name).toBe('string');
      expect((error.message as string).length, entry.name).toBeGreaterThan(0);
    }
  });

  it('keeps client responses in the Anthropic error shape and never in the admin shape', async () => {
    anthropicProvider();
    createApiKey('shape', 'key-shape');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })),
    );

    const unauthorized = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, { body: { model: 'x', messages: [] } }),
    );
    const upstreamError = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'x', messages: [] },
        headers: { 'x-api-key': 'ar-' + '1'.repeat(32) },
      }),
    );
    const malformed = await chatRoute.POST(
      new Request(`${BASE}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'ar-' + '2'.repeat(32) },
        body: '{oops',
      }),
    );

    for (const [name, response] of [
      ['unauthorized', unauthorized],
      ['upstream error', upstreamError],
      ['malformed body', malformed],
    ] as const) {
      expect(response.status, name).toBeGreaterThanOrEqual(400);
      const payload = await readJson<Record<string, unknown>>(response);
      // C4's admin envelope must never leak onto the client surface...
      expect(payload, name).not.toHaveProperty('data');
      // ...which is always the Anthropic `{type:'error',error:{type,message}}` shape.
      expect(Object.keys(payload).sort(), name).toEqual(['error', 'type']);
      expect(payload.type, name).toBe('error');
      const error = payload.error as Record<string, unknown>;
      expect(typeof error.type, name).toBe('string');
      expect(typeof error.message, name).toBe('string');
      expect((error.message as string).length, name).toBeGreaterThan(0);
    }
  });
});

describe('admin writes: hostile input', () => {
  it('rejects oversized, control-character and non-string names', async () => {
    const cases: unknown[] = ['n'.repeat(65), 'n'.repeat(10_000), 42, null, ['a'], { a: 1 }, true];
    for (const name of cases) {
      const response = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name } }));
      expect(response.status, JSON.stringify(name)?.slice(0, 20)).toBe(400);
      expect((await readJson<{ error: { message: string } }>(response)).error.message).toContain('name');
    }

    const messy = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: '\u0000Ad\u0007min\u001f' } }));
    expect(messy.status).toBe(200);
    const created = (await readJson<{ data: { name: string } }>(messy)).data;
    expect(created.name).toBe('Admin');
  });

  it('stores a SQL-looking name verbatim without executing it', async () => {
    const name = "l'); DROP TABLE api_keys; --";
    const response = await keysRoute.POST(adminRequest('/api/admin/keys', { body: { name } }));
    expect(response.status).toBe(200);
    expect((await readJson<{ data: { name: string } }>(response)).data.name).toBe(name);
    expect(queryAll('SELECT id FROM api_keys')).toHaveLength(1);
  });

  it('rejects unsafe provider URLs and header-injecting credentials', async () => {
    const base = { name: 'p', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-x' };
    const rejected: Array<Record<string, unknown>> = [
      { ...base, baseUrl: 'file:///etc/passwd' },
      { ...base, baseUrl: 'javascript:alert(1)' },
      { ...base, baseUrl: 'ftp://example.com' },
      { ...base, baseUrl: 'https://user:pass@example.com' },
      { ...base, baseUrl: 'not a url' },
      { ...base, baseUrl: '' },
      { ...base, baseUrl: `https://${'a'.repeat(600)}.com` },
      { ...base, apiKey: 'sk-x\r\nX-Injected: 1' },
      { ...base, apiKey: 'sk-x\nX-Injected: 1' },
      { ...base, apiKey: 'sk-x\tY' },
      { ...base, apiKey: '' },
      { ...base, protocol: 'grpc' },
      { ...base, protocol: null },
      { ...base, enabled: 'maybe' },
    ];

    for (const body of rejected) {
      const response = await providersRoute.POST(adminRequest('/api/admin/providers', { body }));
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(queryAll('SELECT id FROM providers')).toHaveLength(0);
  });

  it('masks short credentials completely and long ones partially', async () => {
    const shortResponse = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'short', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123' },
      }),
    );
    const shortProvider = (await readJson<{ data: ProviderPublic }>(shortResponse)).data;
    expect(shortProvider.maskedKey).toBe('••••');

    const longResponse = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body: { name: 'long', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abcdefghijklmnop' },
      }),
    );
    const longProvider = (await readJson<{ data: ProviderPublic }>(longResponse)).data;
    expect(longProvider.maskedKey).toBe('sk-a…mnop');
    expect(longProvider.maskedKey).not.toBe('sk-abcdefghijklmnop');
  });

  it('rejects a body that is not a JSON object', async () => {
    const bodies = ['', '   ', '[1,2,3]', '"string"', 'null', '{not json', '{"a":}'];
    for (const body of bodies) {
      const response = await keysRoute.POST(
        new Request(`${BASE}/api/admin/keys`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body,
        }),
      );
      expect(response.status, body).toBe(400);
    }
  });

  it('does not pollute Object.prototype through a __proto__ payload', async () => {
    const response = await providersRoute.POST(
      adminRequest('/api/admin/providers', {
        body:
          '{"name":"pollute","protocol":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"sk-x",' +
          '"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
      }),
    );
    expect(response.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(queryAll('SELECT id FROM providers')).toHaveLength(1);
  });
});

describe('provider probe: 5 second budget (C6)', () => {
  it('reports a timeout without echoing the credential', async () => {
    const provider = anthropicProvider('sk-ant-timeout-secret');
    const captured: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init) captured.push(init);
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }),
    );

    const response = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    expect(response.status).toBe(200);
    const body = (await readJson<{ data: { ok: boolean; message: string } }>(response)).data;
    expect(body.ok).toBe(false);
    expect(body.message).toContain('5000 ms');
    expect(body.message).not.toContain('sk-ant-timeout-secret');

    const init = captured[0];
    expect(init?.signal, 'the probe must be abortable').toBeInstanceOf(AbortSignal);
    expect((init?.signal as AbortSignal).aborted).toBe(false);
  });

  it('reports a plain transport failure as unreachable', async () => {
    const provider = anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('getaddrinfo ENOTFOUND api.anthropic.com');
      }),
    );
    const response = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    const body = (await readJson<{ data: { ok: boolean; message: string } }>(response)).data;
    expect(body.ok).toBe(false);
    expect(body.message).toContain('unreachable');
    expect(body.message).toContain('ENOTFOUND');
  });

  it('treats a non-JSON 200 answer as reachable and a 5xx as failed', async () => {
    const provider = anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('</html>', { status: 200 })),
    );
    const okResponse = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    const okBody = (await readJson<{ data: { ok: boolean; message: string } }>(okResponse)).data;
    expect(okBody.ok).toBe(true);
    expect(okBody.message).toContain('reachable');

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 503, statusText: 'Service Unavailable' })));
    const failed = await providerTestRoute.POST(
      adminRequest(`/api/admin/providers/${provider.id}/test`, { body: {} }),
      routeContext({ id: provider.id }),
    );
    const failedBody = (await readJson<{ data: { ok: boolean; message: string } }>(failed)).data;
    expect(failedBody.ok).toBe(false);
    expect(failedBody.message).toContain('503');
  });
});

describe('stream flag coercion (C9)', () => {
  it('only accepts a real boolean true from the body', async () => {
    anthropicProvider();
    const observed: boolean[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url: string | URL | Request, init?: RequestInit) => {
        observed.push(new Headers(init?.headers).get('accept') === 'text/event-stream');
        return new Response(JSON.stringify({ model: 'claude-3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    for (const stream of ['true', 1, 'yes', null, {}, [], false]) {
      const body = { model: 'claude-3', messages: [], stream };
      const result = await relay({
        protocol: 'anthropic',
        request: new Request(`${BASE}/api/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        body,
      });
      expect(result.response.headers.get('content-type'), JSON.stringify(stream)).toContain('application/json');
      expect(result.log.stream).toBe(false);
      await result.response.text();
    }
    expect(observed.every((flag) => flag === false)).toBe(true);

    const streamingBody = { model: 'claude-3', messages: [], stream: true };
    const streaming = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(streamingBody),
      }),
      body: streamingBody,
    });
    expect(observed.at(-1)).toBe(true);
    await streaming.response.text();
  });
});
