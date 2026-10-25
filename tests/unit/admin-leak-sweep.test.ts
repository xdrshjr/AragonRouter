import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providerTestRoute from '@/app/api/admin/providers/[id]/test/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import { createApiKey } from '@/lib/apikeys';
import { createProvider } from '@/lib/providers';
import type { ApiKeyPublic, ProviderPublic } from '@/lib/types';
import {
  TEST_ADMIN_PASSWORD,
  UPSTREAM_ANTHROPIC_KEY,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
  routeContext,
} from './test-helpers';

/**
 * WP1 · acceptance: "no admin response may contain the upstream plaintext api_key
 * (only maskedKey)".
 *
 * The other suites pin this one endpoint at a time (`redaction.test.ts` sweeps
 * `/api/admin/logs`, `empty-body.test.ts` checks the provider list). This file
 * sweeps the *whole* admin surface - every method of every C3-C8 route, on the
 * authorized and the unauthorized path - after the gateway has been made to hold a
 * credential that a hostile upstream echoes back in its body, its reason phrase and
 * its model probe. A single endpoint that forgets to route its payload through
 * `maskKey` / `redactSecrets` therefore fails here even if its own unit test passes.
 *
 * Offline by construction: `fetch` is stubbed on every path that would leave the
 * process (the relay and the provider probe) and `DATABASE_PATH` is `:memory:`
 * (see `prepareTestEnv`).
 */

const BASE = 'http://localhost';
/** The plaintext upstream credential seeded into the provider row. */
const SECRET = UPSTREAM_ANTHROPIC_KEY;
/**
 * The middle of the credential: `maskKey` reveals the first and last four
 * characters, so this fragment must never appear anywhere in an admin response.
 */
const SECRET_CORE = SECRET.slice(5, -5);
const PROVIDER_NAME = 'anthropic-primary';

interface SurfaceCall {
  name: string;
  run: () => Promise<Response>;
}

/** Every `/api/admin/**` handler the console and the scripts can reach (C3-C8). */
function adminSurface(providerId: string, keyId: string): SurfaceCall[] {
  return [
    {
      name: 'GET /api/admin/session',
      run: () => sessionRoute.GET(jsonRequest(`${BASE}/api/admin/session`, { method: 'GET', headers: adminHeaders() })),
    },
    {
      name: 'POST /api/admin/session',
      run: () =>
        sessionRoute.POST(
          jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
        ),
    },
    {
      name: 'DELETE /api/admin/session',
      run: () =>
        sessionRoute.DELETE(jsonRequest(`${BASE}/api/admin/session`, { method: 'DELETE', headers: adminHeaders() })),
    },
    {
      name: 'GET /api/admin/keys',
      run: () => keysRoute.GET(jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: adminHeaders() })),
    },
    {
      name: 'POST /api/admin/keys',
      run: () =>
        keysRoute.POST(
          jsonRequest(`${BASE}/api/admin/keys`, { body: { name: 'swept-key' }, headers: adminHeaders() }),
        ),
    },
    {
      name: 'GET /api/admin/keys/[id]',
      run: () =>
        keysIdRoute.GET(
          jsonRequest(`${BASE}/api/admin/keys/${keyId}`, { method: 'GET', headers: adminHeaders() }),
          routeContext({ id: keyId }),
        ),
    },
    {
      name: 'GET /api/admin/providers',
      run: () =>
        providersRoute.GET(jsonRequest(`${BASE}/api/admin/providers`, { method: 'GET', headers: adminHeaders() })),
    },
    {
      name: 'POST /api/admin/providers',
      run: () =>
        providersRoute.POST(
          jsonRequest(`${BASE}/api/admin/providers`, {
            body: {
              name: 'swept-provider',
              protocol: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              apiKey: SECRET,
            },
            headers: adminHeaders(),
          }),
        ),
    },
    {
      name: 'GET /api/admin/providers/[id]',
      run: () =>
        providersIdRoute.GET(
          jsonRequest(`${BASE}/api/admin/providers/${providerId}`, { method: 'GET', headers: adminHeaders() }),
          routeContext({ id: providerId }),
        ),
    },
    {
      name: 'PATCH /api/admin/providers/[id]',
      run: () =>
        providersIdRoute.PATCH(
          jsonRequest(`${BASE}/api/admin/providers/${providerId}`, {
            method: 'PATCH',
            body: { name: 'renamed-provider' },
            headers: adminHeaders(),
          }),
          routeContext({ id: providerId }),
        ),
    },
    {
      name: 'POST /api/admin/providers/[id]/test',
      run: () =>
        providerTestRoute.POST(
          jsonRequest(`${BASE}/api/admin/providers/${providerId}/test`, {
            method: 'POST',
            headers: adminHeaders(),
          }),
          routeContext({ id: providerId }),
        ),
    },
    {
      name: 'GET /api/admin/logs',
      run: () =>
        logsRoute.GET(jsonRequest(`${BASE}/api/admin/logs?limit=50`, { method: 'GET', headers: adminHeaders() })),
    },
    {
      name: 'GET /api/admin/stats',
      run: () =>
        statsRoute.GET(jsonRequest(`${BASE}/api/admin/stats?range=24h`, { method: 'GET', headers: adminHeaders() })),
    },
  ];
}

/**
 * Drain a response and fail when the credential - or the part of it the mask is
 * supposed to hide - appears in the body or in any header.
 */
async function expectNoCredential(call: SurfaceCall): Promise<{ status: number; text: string; response: Response }> {
  const response = await call.run();
  const text = await response.text();
  const headerDump = Array.from(response.headers.entries())
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

  expect(response.status, call.name).toBeLessThan(500);
  expect(text, call.name).not.toContain(SECRET);
  expect(text, call.name).not.toContain(SECRET_CORE);
  expect(headerDump, call.name).not.toContain(SECRET);
  expect(headerDump, call.name).not.toContain(SECRET_CORE);
  return { status: response.status, text, response };
}

/** An upstream that echoes the credential it was given, in every channel it can. */
function echoingUpstream(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(`{"error":{"message":"invalid x-api-key ${SECRET}"}}`, {
        status: 401,
        statusText: `Unauthorized ${SECRET}`,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function seededProvider(): ProviderPublic {
  return createProvider({
    name: PROVIDER_NAME,
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: SECRET,
  });
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin surface: the upstream plaintext credential never appears (acceptance)', () => {
  it('keeps the plaintext key out of every authorized admin response', async () => {
    const provider = seededProvider();
    const clientKey = createApiKey('sweep-client', 'key-sweep');
    // Both the relay and the provider probe hit this stub, so every path that can
    // carry upstream material is exercised with an echoing upstream.
    vi.stubGlobal('fetch', echoingUpstream());

    // Make the gateway produce a log row whose upstream error echoed the credential.
    const relayed = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3', messages: [] },
        headers: { 'x-api-key': clientKey.key },
      }),
    );
    expect(relayed.status).toBe(401);
    const clientBody = await relayed.text();
    // The lowest-privilege client never receives the operator's key either...
    expect(clientBody).not.toContain(SECRET);
    expect(clientBody).not.toContain(SECRET_CORE);

    for (const call of adminSurface(provider.id, clientKey.public.id)) {
      const { status } = await expectNoCredential(call);
      // Logging in is 200; everything else on the authorized path is 200 as well.
      expect(status, call.name).toBe(200);
    }

    // The provider payloads carry `maskedKey` - a redaction, not the credential.
    const listed = await providersRoute.GET(
      jsonRequest(`${BASE}/api/admin/providers`, { method: 'GET', headers: adminHeaders() }),
    );
    const payload = await readJson<{ data: ProviderPublic[] }>(listed);
    expect(payload.data.length).toBeGreaterThan(0);
    for (const entry of payload.data) {
      expect(entry.maskedKey).not.toBe(SECRET);
      expect(entry.maskedKey).not.toContain(SECRET_CORE);
      // No plaintext field is even published on the shape.
      expect(Object.keys(entry)).not.toContain('apiKey');
      expect(Object.keys(entry)).not.toContain('api_key');
    }

    // C5 keys stay plaintext-free apart from the single creation response.
    const keys = await keysRoute.GET(
      jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: adminHeaders() }),
    );
    const keyPayload = await readJson<{ data: ApiKeyPublic[] }>(keys);
    for (const entry of keyPayload.data) expect(entry).not.toHaveProperty('key');

    // A harness sanity check: the echo really happened, so the sweep was not empty.
    const rows = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?limit=50`, { method: 'GET', headers: adminHeaders() }),
    );
    const logPayload = await readJson<{ data: Array<{ status: number; error: string | null }> }>(rows);
    expect(logPayload.data).toHaveLength(1);
    expect(logPayload.data[0]?.status).toBe(401);
    expect(logPayload.data[0]?.error).toBeTruthy();
    expect(logPayload.data[0]?.error ?? '').toContain('[redacted]');
  });

  it('answers 401 {error:{message:"unauthorized"}} on every admin route without a credential leak', async () => {
    const provider = seededProvider();
    const clientKey = createApiKey('unauthorized-client', 'key-unauthorized');
    vi.stubGlobal('fetch', echoingUpstream());

    const requests: SurfaceCall[] = [
      {
        name: 'GET /api/admin/session',
        run: () => sessionRoute.GET(jsonRequest(`${BASE}/api/admin/session`, { method: 'GET' })),
      },
      {
        name: 'DELETE /api/admin/session',
        run: () => sessionRoute.DELETE(jsonRequest(`${BASE}/api/admin/session`, { method: 'DELETE' })),
      },
      {
        name: 'GET /api/admin/keys',
        run: () => keysRoute.GET(jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET' })),
      },
      {
        name: 'POST /api/admin/keys',
        run: () => keysRoute.POST(jsonRequest(`${BASE}/api/admin/keys`, { body: { name: 'nope' } })),
      },
      {
        name: 'GET /api/admin/keys/[id]',
        run: () =>
          keysIdRoute.GET(
            jsonRequest(`${BASE}/api/admin/keys/${clientKey.public.id}`, { method: 'GET' }),
            routeContext({ id: clientKey.public.id }),
          ),
      },
      {
        name: 'GET /api/admin/providers',
        run: () => providersRoute.GET(jsonRequest(`${BASE}/api/admin/providers`, { method: 'GET' })),
      },
      {
        name: 'POST /api/admin/providers',
        run: () =>
          providersRoute.POST(
            jsonRequest(`${BASE}/api/admin/providers`, {
              body: { name: 'nope', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'x' },
            }),
          ),
      },
      {
        name: 'GET /api/admin/providers/[id]',
        run: () =>
          providersIdRoute.GET(
            jsonRequest(`${BASE}/api/admin/providers/${provider.id}`, { method: 'GET' }),
            routeContext({ id: provider.id }),
          ),
      },
      {
        name: 'POST /api/admin/providers/[id]/test',
        run: () =>
          providerTestRoute.POST(
            jsonRequest(`${BASE}/api/admin/providers/${provider.id}/test`, { method: 'POST' }),
            routeContext({ id: provider.id }),
          ),
      },
      {
        name: 'GET /api/admin/logs',
        run: () => logsRoute.GET(jsonRequest(`${BASE}/api/admin/logs?limit=50`, { method: 'GET' })),
      },
      {
        name: 'GET /api/admin/stats',
        run: () => statsRoute.GET(jsonRequest(`${BASE}/api/admin/stats?range=24h`, { method: 'GET' })),
      },
    ];

    const fetchMock = vi.mocked(globalThis.fetch);
    for (const call of requests) {
      const { status, text } = await expectNoCredential(call);
      // C3: a missing session is always this exact 401, never a 500 and never a
      // body that describes the gateway's internals.
      expect(status, call.name).toBe(401);
      expect(JSON.parse(text), call.name).toEqual({ error: { message: 'unauthorized' } });
    }
    // An unauthenticated call must not reach an upstream at all.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provider probe: a hostile answer is reported without the credential', () => {
  it('reports the real status while scrubbing body and reason phrase echoes', async () => {
    const provider = seededProvider();
    vi.stubGlobal('fetch', echoingUpstream());

    const response = await providerTestRoute.POST(
      jsonRequest(`${BASE}/api/admin/providers/${provider.id}/test`, {
        method: 'POST',
        headers: adminHeaders(),
      }),
      routeContext({ id: provider.id }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET_CORE);

    const payload = JSON.parse(text) as { data: { ok: boolean; message: string } };
    // The probe failed, and says so with something an operator can act on.
    expect(payload.data.ok).toBe(false);
    expect(payload.data.message).toContain('401');
    expect(payload.data.message.length).toBeGreaterThan(0);
  });

  it('keeps the credential out of the 404 for an unknown provider id', async () => {
    seededProvider();
    vi.stubGlobal('fetch', echoingUpstream());
    const response = await providerTestRoute.POST(
      jsonRequest(`${BASE}/api/admin/providers/does-not-exist/test`, { method: 'POST', headers: adminHeaders() }),
      routeContext({ id: 'does-not-exist' }),
    );
    const text = await response.text();
    expect(response.status).toBe(404);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toHaveProperty('error.message');
  });
});
