/**
 * Cross-module boundary test: WP1's empty-body fix as the *console* sees it.
 *
 * The gateway work package fixed a defect where an upstream 204 / 205 / 304 made
 * `relay()` throw, so the client got a 502 while `request_logs` recorded the real
 * upstream status with `error = NULL`. The gateway tests pin the wire behaviour;
 * this file pins what the operator's screen does with those rows, through the
 * console's own transport (`src/components/console/api.ts`), its formatters and its
 * table component:
 *
 *   relay() 204/205/304  ->  request_logs
 *                        ->  GET /api/admin/logs + /api/admin/stats (real handlers)
 *                        ->  listLogs() / getStats() (console client)
 *                        ->  statusTone / formatPercent / <LogTable /> markup
 *
 * Offline and in-memory: the console goes through `support/admin-harness.ts` (real
 * route handlers, cookie jar, no HTTP server) and the relay gets an injected
 * `fetch`, so nothing leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createProvider,
  getStats,
  listLogs,
  signIn,
} from '@/components/console/api';
import { buildLogsQuery } from '@/components/console/log-query';
import { formatPercent, formatTokens, statusTone } from '@/components/console/format';
import { LogTable } from '@/components/console/LogTable';
import type { RequestLogPublic } from '@/components/console/types';
import { relay } from '@/lib/proxy';
import { insertRequestLog } from '@/lib/logs';

import { installAdminHarness, prepareGatewayEnv, TEST_ADMIN_PASSWORD, type AdminHarness } from './support/admin-harness';

const UPSTREAM_SECRET = 'sk-ant-null-body-boundary-secret';
const NULL_BODY_STATUSES = [204, 205, 304] as const;

let harness: AdminHarness;

beforeEach(() => {
  prepareGatewayEnv();
  harness = installAdminHarness();
});

afterEach(() => {
  harness.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Drive the real relay against an upstream that answers `status` with no body. */
async function relayWithStatus(status: number): Promise<Response> {
  const result = await relay({
    protocol: 'anthropic',
    request: new Request('http://console.test/api/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ar-client' },
      body: JSON.stringify({ model: 'claude-null-body', messages: [] }),
    }),
    body: { model: 'claude-null-body', messages: [] },
    apiKeyId: 'key-null-body',
    fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status })),
  });
  return result.response;
}

async function seedNullBodyRows(): Promise<void> {
  await signIn(TEST_ADMIN_PASSWORD);
  const provider = await createProvider({
    name: 'anthropic-null-body',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: UPSTREAM_SECRET,
    enabled: true,
  });
  // C6: the console only ever holds a redacted rendering of the credential.
  expect(provider.maskedKey.length).toBeGreaterThan(0);
  expect(provider.maskedKey).not.toContain(UPSTREAM_SECRET.slice(5, -5));

  for (const status of NULL_BODY_STATUSES) {
    const response = await relayWithStatus(status);
    // The fix under test: the client receives the upstream status itself, never a
    // 502 invented by a `Response` constructor `TypeError`.
    expect(response.status, String(status)).toBe(status);
    expect(response.body, String(status)).toBeNull();
    expect(await response.text(), String(status)).toBe('');
  }
}

describe('null-body statuses reach the console as ordinary answers', () => {
  it('lists 204/205/304 rows with no error and renders them as non-failures', async () => {
    await seedNullBodyRows();

    const page = await listLogs({ limit: 50 });
    expect(page.data).toHaveLength(NULL_BODY_STATUSES.length);
    expect(page.nextCursor).toBeNull();

    const statuses = page.data.map((row) => row.status).sort((a, b) => a - b);
    expect(statuses).toEqual([204, 205, 304]);
    for (const row of page.data) {
      expect(row.error, String(row.status)).toBeNull();
      expect(row.apiKeyId).toBe('key-null-body');
      expect(row.model).toBe('claude-null-body');
      // `createdAt` is an ISO string on the C8 shape, so the table can format it.
      expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
      // A null-body answer is a normal answer, never a warning or a failure.
      // (204/205 are 2xx -> `success`; 304 is a 3xx revalidation -> `info`, which is
      // still "not a failure" - the point is that neither is warning/danger.)
      expect(['success', 'info'], String(row.status)).toContain(statusTone(row.status));
    }

    const markup = renderToStaticMarkup(<LogTable rows={page.data} />);
    for (const status of NULL_BODY_STATUSES) {
      expect(markup, String(status)).toContain(`>${status}<`);
    }
    // No error cell tooltip and no danger tone: nothing failed.
    expect(markup).not.toContain('upstream responded');
    expect(markup).not.toContain('text-danger');
    // None of these calls streamed, so no SSE badge may appear.
    expect(markup).not.toContain('SSE');
    // The upstream credential is never part of a log row.
    expect(markup).not.toContain(UPSTREAM_SECRET);
  });

  it('counts null-body rows as requests, not as errors, in the overview statistics', async () => {
    await seedNullBodyRows();

    const stats = await getStats('24h');
    expect(stats.range).toBe('24h');
    // C7: totals.requests is the number of request_logs rows in the window.
    expect(stats.totals.requests).toBe(NULL_BODY_STATUSES.length);
    // The console renders this through formatPercent - a 0 fraction must read "0%".
    expect(stats.totals.errorRate).toBe(0);
    expect(formatPercent(stats.totals.errorRate)).toBe('0%');
    // No tokens were reported by a body-less answer.
    expect(formatTokens(stats.totals.inputTokens)).toBe('0');
    expect(formatTokens(stats.totals.outputTokens)).toBe('0');
    // Every row lands in a series bucket, so the inline SVG chart is not empty.
    expect(stats.series.reduce((sum, point) => sum + point.requests, 0)).toBe(NULL_BODY_STATUSES.length);
    expect(stats.series.reduce((sum, point) => sum + point.errors, 0)).toBe(0);
    // The model is still attributed: the relay records it from the request body.
    const byModel = stats.byModel.find((entry) => entry.model === 'claude-null-body');
    expect(byModel?.requests).toBe(NULL_BODY_STATUSES.length);
  });

  it('still marks a genuinely failed row as a failure, so the contrast is real', async () => {
    await seedNullBodyRows();
    insertRequestLog({
      protocol: 'anthropic',
      path: '/api/v1/messages',
      model: 'claude-null-body',
      upstream: 'anthropic-null-body',
      status: 500,
      latencyMs: 42,
      error: 'upstream exploded',
    });

    const page = await listLogs({ limit: 50 });
    const failed = page.data.filter((row) => row.status >= 400);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toBe('upstream exploded');
    expect(statusTone(500)).toBe('danger');

    const markup = renderToStaticMarkup(<LogTable rows={page.data} />);
    // A failed row is visually distinct: danger tone and the error as the tooltip.
    expect(markup).toContain('text-danger');
    expect(markup).toContain('upstream exploded');

    const stats = await getStats('24h');
    expect(stats.totals.requests).toBe(NULL_BODY_STATUSES.length + 1);
    expect(stats.totals.errorRate).toBe(0.25);
    expect(formatPercent(stats.totals.errorRate)).toBe('25%');
  });

  it('filters the null-body rows through the console query builder (C8 status filter)', async () => {
    await seedNullBodyRows();

    // The console builds this exact query string from the logs page filters.
    expect(buildLogsQuery({ limit: 50, status: '204' })).toBe('?limit=50&status=204');

    const filtered = await listLogs({ limit: 50, status: '204' });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.status).toBe(204);
    expect(filtered.data[0]?.error).toBeNull();

    // Model + status together, as the logs page sends them.
    const combined = await listLogs({ limit: 50, status: '304', model: 'claude-null-body' });
    expect(combined.data.map((row: RequestLogPublic) => row.status)).toEqual([304]);

    // A filter that matches nothing is an empty page rather than an error.
    const none = await listLogs({ limit: 50, status: '502' });
    expect(none.data).toEqual([]);
    expect(none.nextCursor).toBeNull();
  });
});
