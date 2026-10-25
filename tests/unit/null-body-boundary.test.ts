import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as modelsRoute from '@/app/api/v1/models/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { createApiKey } from '@/lib/apikeys';
import { queryAll } from '@/lib/db';
import { createProvider } from '@/lib/providers';
import { hasNullBodyStatus } from '@/lib/proxy';
import {
  UPSTREAM_ANTHROPIC_KEY,
  adminHeaders,
  jsonRequest,
  prepareTestEnv,
  readJson,
} from './test-helpers';

/**
 * WP1 · null-body status invariants across module boundaries.
 *
 * `empty-body.test.ts` pins the *shape* of the 204 / 205 / 304 fix (client status,
 * no body, matching row). This file pins the two properties the acceptance
 * criterion actually states, over the whole status space rather than one status at
 * a time, and it drives them through module seams the narrower suites do not
 * combine:
 *
 *  1. `response.status === request_logs.status` for *every* upstream outcome, so
 *     the console can never disagree with what the client received (the original
 *     defect surfaced as "client 502, row 204, error NULL").
 *  2. `error IS NULL` exactly for answers that are not failures — every status
 *     >= 400 carries a reason, and no null-body status ever invents one.
 *
 * Plus the neighbouring behaviours that share the same code path: an upstream that
 * illegally attaches a payload to a 204 (it must be released, never forwarded),
 * mixed null-body traffic running *concurrently* (one row per call, stats agreeing
 * with the table), conditional requests (`If-None-Match` -> 304) and the model
 * catalogue degrading gracefully when a provider answers 204 or an empty 200.
 *
 * Offline by construction: `fetch` is always injected or stubbed and
 * `DATABASE_PATH` is `:memory:` (see `prepareTestEnv`).
 */

const BASE = 'http://localhost';
const NULL_BODY_STATUSES = [204, 205, 304] as const;

interface LogRow {
  model: string | null;
  status: number;
  error: string | null;
  stream: number;
  api_key_id: string | null;
}

function logRows(): LogRow[] {
  return queryAll<LogRow>('SELECT model, status, error, stream, api_key_id FROM request_logs ORDER BY rowid ASC');
}

function anthropicProvider(name = 'anthropic-main') {
  return createProvider({
    name,
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: UPSTREAM_ANTHROPIC_KEY,
  });
}

function clientRequest(model: string, apiKey: string, extra: Record<string, unknown> = {}): Request {
  return jsonRequest(`${BASE}/api/v1/messages`, {
    body: { model, messages: [{ role: 'user', content: 'hi' }], ...extra },
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('null-body statuses: the client status and the log row never disagree', () => {
  interface Outcome {
    name: string;
    /** Response the (stubbed) upstream produces, or the error transport throws. */
    produce: () => Response | Error;
    expectStatus: number;
    /** True when the answer is a failure the row must explain. */
    expectError: boolean;
  }

  const outcomes: Outcome[] = [
    {
      name: '200 with a JSON body',
      produce: () => new Response('{"usage":{"input_tokens":3,"output_tokens":1}}', { status: 200 }),
      expectStatus: 200,
      expectError: false,
    },
    { name: '204', produce: () => new Response(null, { status: 204 }), expectStatus: 204, expectError: false },
    { name: '205', produce: () => new Response(null, { status: 205 }), expectStatus: 205, expectError: false },
    { name: '304', produce: () => new Response(null, { status: 304 }), expectStatus: 304, expectError: false },
    {
      name: '400 with a JSON error body',
      produce: () => new Response('{"error":{"message":"bad request"}}', { status: 400 }),
      expectStatus: 400,
      expectError: true,
    },
    {
      name: '401 with an empty body',
      produce: () => new Response('', { status: 401 }),
      expectStatus: 401,
      expectError: true,
    },
    {
      name: '500 with a JSON error body',
      produce: () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
      expectStatus: 500,
      expectError: true,
    },
    {
      name: 'a transport failure',
      produce: () => new Error('socket hang up'),
      expectStatus: 502,
      expectError: true,
    },
  ];

  it('keeps the pair consistent for every upstream outcome (no 502/error=null contradiction)', async () => {
    anthropicProvider();
    const created = createApiKey('matrix-client', 'key-matrix');
    const observed: Array<{ name: string; status: number; row: LogRow | undefined }> = [];

    for (const outcome of outcomes) {
      const fetchMock = vi.fn<typeof fetch>(async () => {
        const produced = outcome.produce();
        if (produced instanceof Error) throw produced;
        return produced;
      });
      vi.stubGlobal('fetch', fetchMock);

      const response = await messagesRoute.POST(clientRequest(`matrix-${outcome.expectStatus}`, created.key));
      const body = await response.text();
      expect(fetchMock, outcome.name).toHaveBeenCalledTimes(1);

      // (1) The client sees the upstream status itself — never a 502 born from the
      // `Response` constructor refusing a body on a null-body status.
      expect(response.status, outcome.name).toBe(outcome.expectStatus);
      if (hasNullBodyStatus(outcome.expectStatus)) {
        expect(response.body, outcome.name).toBeNull();
        expect(body, outcome.name).toBe('');
      }

      const rows = logRows();
      const row = rows.at(-1);
      expect(rows, outcome.name).toHaveLength(outcomes.indexOf(outcome) + 1);
      // (2) The row records exactly the status the client received.
      expect(row?.status, outcome.name).toBe(response.status);
      // (3) `error` explains failures and only failures.
      if (outcome.expectError) {
        expect(row?.error, outcome.name).toBeTruthy();
      } else {
        expect(row?.error, outcome.name).toBeNull();
      }
      expect(JSON.stringify(row), outcome.name).not.toContain(UPSTREAM_ANTHROPIC_KEY);
      observed.push({ name: outcome.name, status: response.status, row });
    }

    // Table-wide invariant: no row may claim a failure without a reason, and no
    // null-body row may claim a reason for an answer the client got in full.
    for (const row of logRows()) {
      if (row.status >= 400) {
        expect(row.error, `status ${row.status}`).not.toBeNull();
        expect(row.error, `status ${row.status}`).not.toBe('');
      }
      if (hasNullBodyStatus(row.status)) {
        expect(row.error, `status ${row.status}`).toBeNull();
      }
    }
    expect(observed).toHaveLength(outcomes.length);
  });

  it('answers 503 with a matching row when no provider is configured (no upstream involved)', async () => {
    const created = createApiKey('no-provider-client', 'key-noprov');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await messagesRoute.POST(clientRequest('nowhere', created.key));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 503, api_key_id: 'key-noprov', stream: 0 });
    expect(rows[0]?.error).toBe('no enabled anthropic provider is configured');
    // Same invariant as above: the client status and the row agree.
    expect(rows[0]?.status).toBe(response.status);
  });
});

describe('null-body statuses: an illegal upstream payload is released, never forwarded', () => {
  it('cancels the body a 204 should not have and still answers 204 with no body', async () => {
    anthropicProvider();
    const created = createApiKey('illegal-body-client', 'key-illegal');
    let cancelled = false;
    let pulled = 0;
    const encoder = new TextEncoder();
    // A hostile/broken upstream: 204 by status, but with a payload attached. The
    // Fetch API itself forbids constructing this, so the fake stands in for a
    // genuine protocol violation observed through a proxy in front of the upstream.
    const illegal = {
      status: 204,
      statusText: 'No Content',
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain', 'content-length': '18' }),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(encoder.encode('unexpected payload'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    } as unknown as Response;

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => illegal));

    const response = await messagesRoute.POST(clientRequest('illegal-204', created.key));

    // No `TypeError`, no 502: the answer is the upstream status, body-less.
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    // Announced-payload headers are gone with the payload.
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    // The dangling upstream body was released instead of held open.
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(1);

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 204, error: null, api_key_id: 'key-illegal', stream: 0 });
  });
});

describe('null-body statuses: concurrent traffic stays one-row-per-call', () => {
  it('serves a mixed 200/204/205/304 burst with per-call statuses, rows and stats', async () => {
    anthropicProvider();
    const created = createApiKey('burst-client', 'key-burst');
    const plan: Record<string, number> = {
      'burst-200-a': 200,
      'burst-204-a': 204,
      'burst-205-a': 205,
      'burst-304-a': 304,
      'burst-200-b': 200,
      'burst-204-b': 204,
      'burst-205-b': 205,
      'burst-304-b': 304,
    };
    // The stub answers based on the model the relay forwarded, so the burst can run
    // in parallel without depending on call ordering.
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      const status = plan[payload.model ?? ''] ?? 500;
      return status === 200
        ? new Response('{"usage":{"input_tokens":2,"output_tokens":0}}', {
            status,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(null, { status });
    });
    vi.stubGlobal('fetch', fetchMock);

    const models = Object.keys(plan);
    const responses = await Promise.all(
      models.map((model) => messagesRoute.POST(clientRequest(model, created.key))),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(fetchMock).toHaveBeenCalledTimes(models.length);
    responses.forEach((response, index) => {
      const model = models[index]!;
      expect(response.status, model).toBe(plan[model]);
      expect(response.status, model).not.toBe(502);
      if (hasNullBodyStatus(plan[model]!)) {
        expect(response.body, model).toBeNull();
        expect(bodies[index], model).toBe('');
        expect(response.headers.get('content-type'), model).toBeNull();
      } else {
        expect(bodies[index], model).toContain('input_tokens');
      }
    });

    // Exactly one row per call, each carrying its own call's status.
    const rows = logRows();
    expect(rows).toHaveLength(models.length);
    for (const model of models) {
      const matching = rows.filter((row) => row.model === model);
      expect(matching, model).toHaveLength(1);
      expect(matching[0], model).toMatchObject({ status: plan[model], error: null, api_key_id: 'key-burst' });
    }

    // C7: the dashboard agrees with the table, and a partially body-less burst is
    // not an error burst.
    const stats = (
      await readJson<{
        data: { totals: { requests: number; inputTokens: number; errorRate: number }; series: Array<{ requests: number }> };
      }>(await statsRoute.GET(jsonRequest(`${BASE}/api/admin/stats?range=24h`, { method: 'GET', headers: adminHeaders() })))
    ).data;
    expect(stats.totals.requests).toBe(models.length);
    expect(stats.totals.errorRate).toBe(0);
    expect(stats.totals.inputTokens).toBe(2 * Object.values(plan).filter((status) => status === 200).length);
    expect(stats.series.reduce((sum, point) => sum + point.requests, 0)).toBe(models.length);

    // C8: the status filter can isolate the null-body rows the fix is about.
    const filtered = await readJson<{ data: Array<{ status: number; model: string | null; error: string | null }> }>(
      await logsRoute.GET(
        jsonRequest(`${BASE}/api/admin/logs?limit=50&status=204`, { method: 'GET', headers: adminHeaders() }),
      ),
    );
    expect(filtered.data.map((row) => row.model).sort()).toEqual(['burst-204-a', 'burst-204-b']);
    for (const row of filtered.data) {
      expect(row).toMatchObject({ status: 204, error: null });
    }
  });
});

describe('null-body statuses: conditional requests (C9 header handling + 304)', () => {
  it('forwards If-None-Match, injects the upstream credential and replays the 304 bare', async () => {
    anthropicProvider();
    const created = createApiKey('conditional-client', 'key-cond');
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        seen.push({ url: String(input), headers: new Headers((init?.headers ?? {}) as HeadersInit) });
        return new Response(null, {
          status: 304,
          statusText: 'Not Modified',
          headers: { 'content-type': 'application/json', etag: '"msg-v7"', 'cache-control': 'max-age=30' },
        });
      }),
    );

    const response = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-api-key': created.key, 'if-none-match': '"msg-v7"' },
      }),
    );

    // C9: the client credential is replaced by the provider credential; the
    // conditional header the client sent travels with the request.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]?.headers.get('x-api-key')).toBe(UPSTREAM_ANTHROPIC_KEY);
    expect(seen[0]?.headers.get('if-none-match')).toBe('"msg-v7"');
    expect(seen[0]?.headers.get('cookie')).toBeNull();

    // The 304 reaches the client as a 304 with nothing to read, but the revalidation
    // metadata the SDK needs survives.
    expect(response.status).toBe(304);
    expect(response.status).not.toBe(502);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('etag')).toBe('"msg-v7"');
    expect(response.headers.get('cache-control')).toBe('max-age=30');

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 304, error: null, api_key_id: 'key-cond', stream: 0 });
  });

  it('answers a stream:true request with a bare 205 and logs it as a non-error stream', async () => {
    anthropicProvider();
    const created = createApiKey('stream-205-client', 'key-205');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 205 })));

    const response = await messagesRoute.POST(
      clientRequest('stream-205', created.key, { stream: true }),
    );

    // C9's SSE label may not be advertised for a status that cannot carry a payload.
    expect(response.status).toBe(205);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 205, error: null, stream: 1, api_key_id: 'key-205' });
    // Being non-2xx is not an error when the status simply has no body.
    const stats = (
      await readJson<{ data: { totals: { requests: number; errorRate: number } } }>(
        await statsRoute.GET(jsonRequest(`${BASE}/api/admin/stats?range=24h`, { method: 'GET', headers: adminHeaders() })),
      )
    ).data;
    expect(stats.totals).toMatchObject({ requests: 1, errorRate: 0 });
  });
});

describe('null-body statuses: the model catalogue degrades instead of failing (C9)', () => {
  it('returns an empty list for a provider that answers 204 / an empty 200 / unparsable JSON', async () => {
    anthropicProvider('catalogue-anthropic');
    const created = createApiKey('catalogue-client', 'key-catalogue');
    const answers: Array<{ name: string; produce: () => Response; expectIds: string[] }> = [
      { name: '204', produce: () => new Response(null, { status: 204 }), expectIds: [] },
      {
        name: 'empty 200',
        produce: () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
        expectIds: [],
      },
      {
        name: 'unparsable 200',
        produce: () =>
          new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } }),
        expectIds: [],
      },
      {
        // Duplicates are collapsed and a bare string entry is accepted (OpenAI shape).
        name: 'deduplicating 200',
        produce: () =>
          new Response(
            JSON.stringify({ data: [{ id: 'claude-3-5-sonnet' }, { id: 'claude-3-5-sonnet' }, 'claude-3'] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        expectIds: ['claude-3-5-sonnet', 'claude-3'],
      },
    ];

    for (const answer of answers) {
      vi.unstubAllGlobals();
      const fetchMock = vi.fn<typeof fetch>(async () => answer.produce());
      vi.stubGlobal('fetch', fetchMock);

      const response = await modelsRoute.GET(
        jsonRequest(`${BASE}/api/v1/models`, { method: 'GET', headers: { 'x-api-key': created.key } }),
      );
      expect(fetchMock, answer.name).toHaveBeenCalledTimes(1);
      // A model probe has no body to relay, so no null-body `Response` is built: the
      // catalogue must simply be empty rather than a 5xx.
      expect(response.status, answer.name).toBe(200);
      const payload = await readJson<{ object: string; data: Array<{ id: string }> }>(response);
      expect(payload.object, answer.name).toBe('list');
      expect(payload.data.map((entry) => entry.id), answer.name).toEqual(answer.expectIds);
    }
    // Model discovery never writes a request_log (C8 counts relayed calls only).
    expect(logRows()).toHaveLength(0);
  });
});
