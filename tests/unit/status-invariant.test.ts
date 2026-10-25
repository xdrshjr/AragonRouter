import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import { createApiKey } from '@/lib/apikeys';
import { queryAll } from '@/lib/db';
import {
  RESPONSE_STATUS_MAX,
  RESPONSE_STATUS_MIN,
  hasNullBodyStatus,
  isRelayableStatus,
  relay,
} from '@/lib/proxy';
import { createProvider, maskKey } from '@/lib/providers';
import type { ClientErrorBody, ProviderPublic } from '@/lib/types';
import {
  UPSTREAM_ANTHROPIC_KEY,
  UPSTREAM_OPENAI_KEY,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
} from './test-helpers';

/**
 * WP1 · status invariants around the empty-body fix.
 *
 * The null-body defect was one instance of a wider rule: the relay persists the
 * upstream status *before* it builds the client `Response`, so anything the
 * `Response` constructor refuses would surface as "client 502, row <upstream
 * status>" — the self-contradiction the work package removes.
 *
 * 204 / 205 / 304 (no body allowed) are covered by `empty-body.test.ts` and
 * `null-body-boundary.test.ts`. This file covers the other constructor refusal:
 * a status outside the range the Fetch standard allows (a 1xx interim status
 * leaked by a proxy, a non-HTTP `0`, a bogus 6xx). Such an answer is rejected
 * before any `Response` is built, so the client status and the logged status are
 * the same 502 and the row carries a diagnostic instead of `error = null`.
 *
 * It also pins the `maskedKey` shape: no admin response may hand back enough of
 * a short credential to reconstruct it.
 *
 * Offline by construction: `fetch` is injected or stubbed and the database is
 * `:memory:` (see `prepareTestEnv`).
 */

const BASE = 'http://localhost';

interface LogRow {
  protocol: string;
  path: string;
  model: string | null;
  upstream: string | null;
  status: number;
  latency_ms: number;
  api_key_id: string | null;
  error: string | null;
  stream: number;
}

function logRows(): LogRow[] {
  // `rowid` is insertion order: several calls land in the same millisecond, so
  // `created_at` alone cannot identify the newest row.
  return queryAll<LogRow>('SELECT * FROM request_logs ORDER BY rowid ASC');
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

function clientRequest(path: string, apiKey: string, body: unknown = { model: 'm', messages: [] }): Request {
  return jsonRequest(`${BASE}${path}`, {
    body,
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
}

/**
 * A `fetch` answer with a status the `Response` constructor would refuse.
 *
 * `new Response(null, { status: 0 })` throws (`RangeError`), so a fetch
 * implementation that hands such an answer back cannot be modelled with a real
 * `Response` — this plain object stands in for it, body included, so the test can
 * also prove the payload is released rather than left dangling.
 */
function nonRepresentableResponse(status: number, tracked: { cancelled?: boolean }): Response {
  const encoder = new TextEncoder();
  return {
    status,
    statusText: '',
    ok: false,
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('interim or bogus answer'));
      },
      cancel() {
        tracked.cancelled = true;
      },
    }),
  } as unknown as Response;
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('status representability (the invariant behind the null-body fix)', () => {
  it('accepts exactly the statuses a Response can carry', () => {
    const accepted = [200, 201, 202, 204, 205, 206, 226, 299, 300, 301, 302, 304, 307, 308, 399, 400, 401, 404, 418, 429, 451, 500, 502, 529, 599];
    for (const status of accepted) {
      expect(isRelayableStatus(status), String(status)).toBe(true);
    }
    expect(RESPONSE_STATUS_MIN).toBe(200);
    expect(RESPONSE_STATUS_MAX).toBe(599);
  });

  it('rejects interim, out-of-range and non-integer statuses', () => {
    const rejected = [0, -1, 1, 99, 100, 101, 102, 103, 150, 199, 600, 700, 1000, 200.5, 599.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const status of rejected) {
      expect(isRelayableStatus(status), String(status)).toBe(false);
    }
  });

  it('shows that the constructor really refuses those statuses (guard is not hypothetical)', () => {
    // The invariant only matters because the constructor throws; assert that.
    expect(() => new Response(null, { status: 600 })).toThrow();
    expect(() => new Response(null, { status: 103 })).toThrow();
    // 204 accepts a null body: that half of the invariant is covered elsewhere.
    expect(new Response(null, { status: 204 }).status).toBe(204);
  });
});

describe('an upstream status a Response cannot carry', () => {
  it('answers the client with a 502 and records that same 502 for every such status', async () => {
    anthropicProvider();
    const created = createApiKey('invariant-client', 'key-invariant');
    const statuses = [0, 100, 103, 199, 600, 1000, Number.NaN];

    for (const [index, status] of statuses.entries()) {
      const tracked: { cancelled?: boolean } = {};
      const fetchMock = vi.fn<typeof fetch>(async () => nonRepresentableResponse(status, tracked));
      vi.stubGlobal('fetch', fetchMock);

      const response = await messagesRoute.POST(clientRequest('bad-status', created.key));

      // (1) No throw, no 502-by-accident: the relay's own error answer.
      expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
      expect(response.status, String(status)).toBe(502);
      const body = await readJson<ClientErrorBody>(response);
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('api_error');
      expect(body.error.message).toContain('cannot be relayed');
      expect(body.error.message).not.toContain(UPSTREAM_ANTHROPIC_KEY);

      // (2) Exactly one row, recording the status the client actually received.
      const rows = logRows();
      expect(rows, String(status)).toHaveLength(index + 1);
      const row = rows.at(-1);
      expect(row?.status).toBe(502);
      expect(row?.status).toBe(response.status);
      expect(row?.error).toBeTruthy();
      expect(row?.api_key_id).toBe('key-invariant');
      expect(row?.protocol).toBe('anthropic');
      expect(row?.stream).toBe(0);
      expect(JSON.stringify(row)).not.toContain(UPSTREAM_ANTHROPIC_KEY);

      // (3) The illegal payload was released, never forwarded or held open.
      expect(tracked.cancelled, String(status)).toBe(true);
    }

    // No row anywhere claims a failure without a reason.
    for (const row of logRows()) {
      if (row.status >= 400) expect(row.error).toBeTruthy();
    }
  });

  it('does the same for a stream:true call (no SSE label, no half-open stream)', async () => {
    openaiProvider();
    const created = createApiKey('invariant-stream', 'key-invariant-stream');
    const tracked: { cancelled?: boolean } = {};
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => nonRepresentableResponse(103, tracked)));

    const response = await chatRoute.POST(
      clientRequest('/api/v1/chat/completions', created.key, { model: 'gpt', stream: true }),
    );

    expect(response.status).toBe(502);
    // The client asked for SSE, but this answer is a structured JSON error, not a
    // stream: an off-range upstream status cannot become an event stream.
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await readJson<ClientErrorBody>(response);
    expect(body.error.message).toContain('103');

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'openai',
      status: 502,
      stream: 1,
      api_key_id: 'key-invariant-stream',
    });
    expect(rows[0]?.error).toBeTruthy();
    expect(tracked.cancelled).toBe(true);
  });

  it('keeps the pair consistent when relay() is called directly (both protocols)', async () => {
    anthropicProvider();
    openaiProvider();

    for (const protocol of ['anthropic', 'openai'] as const) {
      const tracked: { cancelled?: boolean } = {};
      const result = await relay({
        protocol,
        request: new Request(`${BASE}/api/v1/relay`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'm', messages: [] }),
        }),
        body: { model: 'm', messages: [] },
        apiKeyId: 'key-direct',
        fetchImpl: vi.fn<typeof fetch>(async () => nonRepresentableResponse(Number.NaN, tracked)),
      });

      expect(result.response.status, protocol).toBe(502);
      expect(result.log.status, protocol).toBe(502);
      expect(result.log.error, protocol).toBeTruthy();
      expect(result.provider?.name, protocol).toBeTruthy();
      expect(await result.response.text(), protocol).toContain('cannot be relayed');
      expect(tracked.cancelled, protocol).toBe(true);
    }

    const rows = logRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual([502, 502]);
    expect(rows.map((row) => row.error !== null)).toEqual([true, true]);
  });

  it('still relays every representable status unchanged (no regression from the guard)', async () => {
    anthropicProvider();
    const created = createApiKey('representable-client', 'key-representable');
    const statuses = [200, 201, 204, 205, 206, 301, 302, 304, 400, 418, 500, 529, 599];

    for (const [index, status] of statuses.entries()) {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => new Response(null, { status })),
      );

      const response = await messagesRoute.POST(clientRequest('representable', created.key));

      expect(response.status, String(status)).toBe(status);
      if (hasNullBodyStatus(status)) expect(response.body, String(status)).toBeNull();
      const rows = logRows();
      expect(rows, String(status)).toHaveLength(index + 1);
      const row = rows.at(-1);
      expect(row?.status, String(status)).toBe(status);
      // `error` explains failures and only failures.
      expect(row?.error === null, String(status)).toBe(status < 400);
      expect(JSON.stringify(row)).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    }
  });
});

describe('maskedKey never becomes a copy of the credential', () => {
  it('hides short credentials entirely and reveals at most half of long ones', () => {
    expect(maskKey('')).toBe('');

    for (let length = 1; length <= 40; length += 1) {
      const secret = 'k'.repeat(length);
      const masked = maskKey(secret);
      const revealed = masked.replace(/[•…]/g, '');

      // Never the credential itself, and never more than half of it.
      expect(masked, `length ${length}`).not.toBe(secret);
      expect(revealed.length, `length ${length}`).toBeLessThanOrEqual(Math.floor(length / 2));
      // Short credentials are not identifiable at all; long ones keep both ends.
      if (length < 16) {
        expect(masked, `length ${length}`).toBe('••••');
      } else {
        expect(masked, `length ${length}`).toContain('…');
        expect(revealed.slice(0, 4), `length ${length}`).toBe(secret.slice(0, 4));
        expect(revealed.slice(-4), `length ${length}`).toBe(secret.slice(-4));
      }
    }
  });

  it('masks a short credential created through the admin API', async () => {
    const shortKey = 'sk-12345678'; // 11 characters: too short to reveal eight of them
    const created = await providersRoute.POST(
      jsonRequest(`${BASE}/api/admin/providers`, {
        body: {
          name: 'short-lived',
          protocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: shortKey,
        },
        headers: adminHeaders(),
      }),
    );
    expect(created.status).toBe(200);
    const createdText = await created.text();
    expect(createdText).not.toContain(shortKey);
    expect((JSON.parse(createdText) as { data: ProviderPublic }).data.maskedKey).toBe('••••');

    const listed = await providersRoute.GET(
      jsonRequest(`${BASE}/api/admin/providers`, { method: 'GET', headers: adminHeaders() }),
    );
    const listedText = await listed.text();
    expect(listedText).not.toContain(shortKey);
    const payload = JSON.parse(listedText) as { data: ProviderPublic[] };
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]?.maskedKey).toBe('••••');
    expect(JSON.stringify(payload.data[0])).not.toContain(shortKey.slice(0, 8));
  });
});
