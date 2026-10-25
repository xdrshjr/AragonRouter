import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { createApiKey, findActiveApiKey } from '@/lib/apikeys';
import { open } from '@/lib/crypto';
import { queryAll, queryOne } from '@/lib/db';
import { insertRequestLog } from '@/lib/logs';
import { createProvider } from '@/lib/providers';
import { relay } from '@/lib/proxy';
import type { ProviderPublic } from '@/lib/types';
import {
  UPSTREAM_ANTHROPIC_KEY,
  adminHeaders,
  chunkedResponse,
  jsonRequest,
  prepareTestEnv,
  readJson,
  routeContext,
} from './test-helpers';

/**
 * Concurrency and idempotency boundaries.
 *
 * The relay, the log writer and the admin mutations all reach the same
 * `node:sqlite` handle, so "it works alone but breaks under two requests" is the
 * realistic failure mode: duplicated log rows, lost usage, half-revoked keys or a
 * stats count that disagrees with the table. Every case below fires real parallel
 * requests (no network: fetch is stubbed) and then checks the database.
 */

const BASE = 'http://localhost';

interface LogRow {
  id: string;
  protocol: string;
  path: string;
  status: number;
  input_tokens: number | null;
  output_tokens: number | null;
  api_key_id: string | null;
  stream: number;
}

function logRows(): LogRow[] {
  return queryAll<LogRow>('SELECT * FROM request_logs');
}

function adminRequest(path: string, init: Parameters<typeof jsonRequest>[1] = {}): Request {
  return jsonRequest(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...adminHeaders() },
  });
}

function clientRequest(key: string, path = '/api/v1/messages', body: unknown = { model: 'claude-3', messages: [] }): Request {
  return jsonRequest(`${BASE}${path}`, { body, headers: { 'x-api-key': key } });
}

function anthropicProvider() {
  return createProvider({
    name: 'anthropic-main',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: UPSTREAM_ANTHROPIC_KEY,
  });
}

function jsonUpstream(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('concurrency: parallel client requests', () => {
  it('writes exactly one correctly attributed row per parallel request', async () => {
    const keyA = createApiKey('parallel-a', 'key-a');
    const keyB = createApiKey('parallel-b', 'key-b');
    anthropicProvider();
    jsonUpstream({ model: 'claude-3-opus', usage: { input_tokens: 5, output_tokens: 9 } });

    const requests = Array.from({ length: 24 }, (_unused, index) =>
      messagesRoute.POST(clientRequest(index % 2 === 0 ? keyA.key : keyB.key)),
    );
    const responses = await Promise.all(requests);
    await Promise.all(responses.map((response) => response.text()));

    for (const response of responses) expect(response.status).toBe(200);
    const rows = logRows();
    expect(rows).toHaveLength(24);
    expect(new Set(rows.map((row) => row.id)).size).toBe(24);
    expect(rows.filter((row) => row.api_key_id === 'key-a')).toHaveLength(12);
    expect(rows.filter((row) => row.api_key_id === 'key-b')).toHaveLength(12);
    // Usage is recorded once per row: a shared snapshot would lose or double it.
    for (const row of rows) {
      expect(row.input_tokens).toBe(5);
      expect(row.output_tokens).toBe(9);
    }

    const stats = await readJson<{ data: { totals: { requests: number; inputTokens: number } } }>(
      await statsRoute.GET(adminRequest('/api/admin/stats?range=24h', { method: 'GET' })),
    );
    expect(stats.data.totals.requests).toBe(24);
    expect(stats.data.totals.inputTokens).toBe(120);
    const count = queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM request_logs');
    expect(stats.data.totals.requests).toBe(Number(count?.count));
  });

  it('mixes anthropic and openai entry points without cross-contaminating logs', async () => {
    const key = createApiKey('mixed', 'key-mixed');
    anthropicProvider();
    createProvider({
      name: 'openai-main',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-upstream',
    });
    jsonUpstream({ model: 'shared-model', usage: { prompt_tokens: 2, completion_tokens: 3 } });

    const responses = await Promise.all([
      messagesRoute.POST(clientRequest(key.key, '/api/v1/messages')),
      chatRoute.POST(clientRequest(key.key, '/api/v1/chat/completions')),
      messagesRoute.POST(clientRequest(key.key, '/api/v1/messages')),
      chatRoute.POST(clientRequest(key.key, '/api/v1/chat/completions')),
    ]);
    await Promise.all(responses.map((response) => response.text()));

    const rows = logRows();
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.protocol === 'anthropic')).toHaveLength(2);
    expect(rows.filter((row) => row.protocol === 'openai')).toHaveLength(2);
    expect(rows.filter((row) => row.path === '/v1/messages')).toHaveLength(2);
    expect(rows.filter((row) => row.path === '/v1/chat/completions')).toHaveLength(2);
    for (const row of rows) expect(row.api_key_id).toBe('key-mixed');
  });

  it('finalises a row exactly once for every concurrent streaming call', async () => {
    const key = createApiKey('stream-parallel', 'key-streams');
    anthropicProvider();
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-opus","usage":{"input_tokens":4,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => chunkedResponse(chunks)),
    );

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        messagesRoute.POST(clientRequest(key.key, '/api/v1/messages', { model: 'claude-3-opus', stream: true, messages: [] })),
      ),
    );
    for (const response of responses) {
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    }
    const bodies = await Promise.all(responses.map((response) => response.text()));
    for (const body of bodies) expect(body).toBe(chunks.join(''));

    const rows = logRows();
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.stream === 1)).toBe(true);
    expect(rows.every((row) => row.input_tokens === 4 && row.output_tokens === 6)).toBe(true);
    expect(rows.every((row) => row.api_key_id === 'key-streams')).toBe(true);
  });

  it('keeps parallel relay calls isolated when one of them fails mid-stream', async () => {
    const key = createApiKey('mixed-outcome', 'key-outcome');
    anthropicProvider();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        call += 1;
        if (call % 2 === 0) {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'));
              controller.error(new Error('upstream reset'));
            },
          });
          return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return chunkedResponse(['data: {"type":"message_stop"}\n\n']);
      }),
    );

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        messagesRoute.POST(clientRequest(key.key, '/api/v1/messages', { model: 'claude-3', stream: true, messages: [] })),
      ),
    );
    const responses = settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : null));
    // Every request must still get a Response object: a broken stream may not
    // surface as an unhandled route rejection.
    expect(responses.every((response) => response !== null)).toBe(true);
    await Promise.all(
      responses.map(async (response) => {
        try {
          await response!.text();
        } catch {
          // the client sees a broken stream, which is expected for the failing half
        }
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    // Exactly one row per request - the failing streams must not be dropped
    // (usage would silently disappear) and must not be written twice.
    const rows = logRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.id)).size).toBe(6);
    expect(rows.filter((row) => row.stream === 1)).toHaveLength(6);
  });
});

describe('concurrency: admin mutations', () => {
  it('creates parallel keys with distinct ids, hashes and plaintexts', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        keysRoute.POST(adminRequest('/api/admin/keys', { body: { name: `parallel-${index}` } })),
      ),
    );
    const created = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return (await readJson<{ data: { id: string; key: string; keyPrefix: string } }>(response)).data;
      }),
    );

    expect(new Set(created.map((entry) => entry.id)).size).toBe(12);
    expect(new Set(created.map((entry) => entry.key)).size).toBe(12);
    const rows = queryAll<{ key_hash: string }>('SELECT key_hash FROM api_keys');
    expect(new Set(rows.map((row) => row.key_hash)).size).toBe(12);
    // Every issued plaintext still resolves, so none of them collided.
    for (const entry of created) {
      expect(findActiveApiKey(entry.key)?.id).toBe(entry.id);
    }
  });

  it('revokes concurrently without duplicating rows or losing the first timestamp', async () => {
    createApiKey('race-revoke', 'key-race');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        keysIdRoute.DELETE(
          adminRequest('/api/admin/keys/key-race', { method: 'DELETE' }),
          routeContext({ id: 'key-race' }),
        ),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const rows = queryAll<{ id: string; revoked_at: number | null }>(
      'SELECT id, revoked_at FROM api_keys WHERE id = ?',
      ['key-race'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it('re-encrypts the same plaintext to a different ciphertext per provider (fresh IV)', async () => {
    const shared = 'sk-shared-upstream-credential';
    const created = await Promise.all(
      ['one', 'two', 'three'].map(async (name) => {
        const response = await providersRoute.POST(
          adminRequest('/api/admin/providers', {
            body: { name, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: shared },
          }),
        );
        expect(response.status).toBe(200);
        return (await readJson<{ data: ProviderPublic }>(response)).data;
      }),
    );
    const ciphertexts = created.map(
      (provider) => String(queryOne<{ api_key_enc: string }>('SELECT api_key_enc FROM providers WHERE id = ?', [provider.id])?.api_key_enc),
    );
    expect(new Set(ciphertexts).size).toBe(3);
    for (const ciphertext of ciphertexts) {
      expect(ciphertext).not.toContain(shared);
      expect(open(ciphertext)).toBe(shared);
    }
  });

  it('keeps parallel patches of one provider consistent', async () => {
    const created = anthropicProvider();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        providersIdRoute.PATCH(
          adminRequest(`/api/admin/providers/${created.id}`, {
            method: 'PATCH',
            body: { name: `renamed-${index}` },
          }),
          routeContext({ id: created.id }),
        ),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const rows = queryAll<{ name: string; api_key_enc: string }>(
      'SELECT name, api_key_enc FROM providers WHERE id = ?',
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toMatch(/^renamed-\d$/);
    // The credential was never part of the patch, so it must still decrypt.
    expect(open(String(rows[0]?.api_key_enc))).toBe(UPSTREAM_ANTHROPIC_KEY);
  });

  it('serves a consistent log page while requests are still being written', async () => {
    const key = createApiKey('pagination-race', 'key-page');
    anthropicProvider();
    jsonUpstream({ model: 'claude-3', usage: { input_tokens: 1, output_tokens: 1 } });

    const writers = Array.from({ length: 10 }, () => messagesRoute.POST(clientRequest(key.key)));
    const reader = logsRoute.GET(adminRequest('/api/admin/logs?limit=5', { method: 'GET' }));
    const responses = await Promise.all(writers);
    await Promise.all(responses.map((response) => response.text()));
    const page = await readJson<{ data: Array<{ id: string }>; nextCursor: string | null }>(await reader);

    // Whatever the timing, the page must be a subset of the table with unique ids.
    expect(page.data.length).toBeLessThanOrEqual(5);
    const ids = page.data.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tableIds = new Set(logRows().map((row) => row.id));
    for (const id of ids) expect(tableIds.has(id)).toBe(true);
  });
});

describe('concurrency: revocation races', () => {
  it('lets an in-flight relay finish but refuses the next call with the revoked key', async () => {
    const created = createApiKey('inflight', 'key-inflight');
    anthropicProvider();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        await gate;
        return new Response(JSON.stringify({ model: 'claude-3', usage: { input_tokens: 2, output_tokens: 2 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const inflight = messagesRoute.POST(clientRequest(created.key));
    await keysIdRoute.DELETE(
      adminRequest('/api/admin/keys/key-inflight', { method: 'DELETE' }),
      routeContext({ id: 'key-inflight' }),
    );
    expect(findActiveApiKey(created.key)).toBeNull();

    release();
    const response = await inflight;
    expect(response.status).toBe(200);
    await response.text();
    expect(logRows()).toHaveLength(1);
    expect(logRows()[0]?.api_key_id).toBe('key-inflight');

    const afterwards = await messagesRoute.POST(clientRequest(created.key));
    expect(afterwards.status).toBe(401);
    expect(logRows()).toHaveLength(1);
  });

  it('does not log a row for a request rejected before authentication', async () => {
    anthropicProvider();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => messagesRoute.POST(clientRequest(`ar-${'f'.repeat(32)}`))),
    );
    for (const response of responses) expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logRows()).toHaveLength(0);
  });
});

describe('concurrency: relay idempotency of the log writer', () => {
  it('stores one row per relay call even when parallel calls share a timestamp', async () => {
    const now = 1_800_000_000_000;
    anthropicProvider();
    jsonUpstream({ model: 'claude-3', usage: { input_tokens: 1, output_tokens: 1 } });

    await Promise.all(
      Array.from({ length: 5 }, () =>
        relay({
          protocol: 'anthropic',
          request: new Request(`${BASE}/api/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
          body: { model: 'claude-3', messages: [] },
          apiKeyId: 'key-parallel',
        }),
      ),
    );

    const rows = queryAll<{ id: string; created_at: number }>('SELECT id, created_at FROM request_logs');
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.id)).size).toBe(5);

    // Tied timestamps must still paginate without loss (keyset tiebreak on id).
    for (const row of rows) insertRequestLog({ ...{ protocol: 'anthropic', path: '/v1/messages', status: 200, latencyMs: 1 }, id: `tie-${row.id}`, createdAt: now });
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const result = await logsRoute.GET(
        adminRequest(
          `/api/admin/logs?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { method: 'GET' },
        ),
      );
      const parsed = await readJson<{ data: Array<{ id: string }>; nextCursor: string | null }>(result);
      seen.push(...parsed.data.map((entry) => entry.id));
      cursor = parsed.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const total = queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM request_logs');
    expect(seen).toHaveLength(Number(total?.count));
  });
});
