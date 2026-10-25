import { beforeEach, describe, expect, it } from 'vitest';
import { createApiKey } from '@/lib/apikeys';
import { queryAll, queryOne } from '@/lib/db';
import {
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  countRequestLogsSince,
  encodeCursor,
  insertRequestLog,
  listRequestLogs,
  parseCursor,
  parseLogLimit,
} from '@/lib/logs';
import { computeStats, normalizeStatsRange } from '@/lib/stats';
import { prepareTestEnv } from './test-helpers';

/**
 * `src/lib/logs.ts` and `src/lib/stats.ts` had no dedicated suite: everything they
 * did was only observed indirectly through `/api/admin/logs` and `/api/admin/stats`.
 * These tests pin the pieces the routes rely on but never exercise directly -
 * write-sanitisation, keyset pagination with tied timestamps, the inclusive stats
 * window and the shape of the dense series (C7 / C8 / C12).
 *
 * Offline by construction: DATABASE_PATH=:memory:, no fetch involved.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

function rows(): LogRow[] {
  return queryAll<LogRow>('SELECT * FROM request_logs');
}

function insert(
  overrides: Partial<Parameters<typeof insertRequestLog>[0]> = {},
): string {
  return insertRequestLog({
    protocol: 'anthropic',
    path: '/v1/messages',
    model: 'claude-3',
    upstream: 'anthropic-main',
    status: 200,
    latencyMs: 10,
    inputTokens: 1,
    outputTokens: 2,
    apiKeyId: null,
    error: null,
    stream: false,
    ...overrides,
  });
}

beforeEach(() => {
  prepareTestEnv();
});

describe('logs: write sanitisation (C12)', () => {
  it('truncates non-negative token counts and drops unusable ones', () => {
    insert({ inputTokens: 3.9, outputTokens: -7 });
    insert({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY });
    insert({ inputTokens: null, outputTokens: undefined });

    const [first, second, third] = rows();
    expect(first?.input_tokens).toBe(3);
    expect(first?.output_tokens).toBeNull();
    expect(second?.input_tokens).toBeNull();
    expect(second?.output_tokens).toBeNull();
    expect(third?.input_tokens).toBeNull();
    expect(third?.output_tokens).toBeNull();
  });

  it('keeps latency non-negative and truncates status', () => {
    insert({ latencyMs: -1_500, status: 200.9 });
    insert({ latencyMs: 12.7, status: 503 });
    const [first, second] = rows();
    expect(first?.latency_ms).toBe(0);
    expect(first?.status).toBe(200);
    expect(second?.latency_ms).toBe(12);
    expect(second?.status).toBe(503);
  });

  it('treats blank text as NULL and strips control characters', () => {
    insert({ model: '   ', upstream: '', error: '\u0000\u0001' });
    insert({ model: 'claude\u0000-3', upstream: 'up\u0007stream', error: 'bad\r\nthing' });
    const [blank, cleaned] = rows();
    expect(blank?.model).toBeNull();
    expect(blank?.upstream).toBeNull();
    expect(blank?.error).toBeNull();
    expect(cleaned?.model).toBe('claude-3');
    expect(cleaned?.upstream).toBe('upstream');
    // \r and \n are layout characters, not control noise: they are kept but trimmed.
    expect(cleaned?.error).toBe('bad\r\nthing');
  });

  it('clips oversized model and error values instead of storing them whole', () => {
    insert({ model: 'm'.repeat(400), error: 'e'.repeat(5_000) });
    const row = rows()[0];
    expect((row?.model ?? '').length).toBeLessThanOrEqual(201);
    expect((row?.model ?? '').endsWith('…')).toBe(true);
    expect((row?.error ?? '').length).toBeLessThanOrEqual(1_001);
    expect((row?.error ?? '').endsWith('…')).toBe(true);
  });

  it('floors the stream flag to 0/1 and honours an explicit id and timestamp', () => {
    insert({ id: 'fixed-id', createdAt: 1_700_000_000_000, stream: true });
    insert({ stream: false });
    const [fixed] = rows().filter((row) => row.id === 'fixed-id');
    expect(fixed?.created_at).toBe(1_700_000_000_000);
    expect(fixed?.stream).toBe(1);
    expect(rows().filter((row) => row.id !== 'fixed-id')[0]?.stream).toBe(0);
  });

  it('generates unique row ids', () => {
    const ids = new Set(Array.from({ length: 25 }, () => insert()));
    expect(ids.size).toBe(25);
  });
});

describe('logs: limit and cursor parsing (C8)', () => {
  it('parses the documented limit values', () => {
    expect(parseLogLimit(undefined)).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit(null)).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit('')).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit('25')).toBe(25);
    expect(parseLogLimit(25)).toBe(25);
    expect(parseLogLimit('0')).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit('-10')).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit('abc')).toBe(DEFAULT_LOG_LIMIT);
    expect(parseLogLimit('12.9')).toBe(12);
    expect(parseLogLimit('99999')).toBe(MAX_LOG_LIMIT);
    expect(MAX_LOG_LIMIT).toBe(200);
    expect(DEFAULT_LOG_LIMIT).toBe(50);
  });

  it('round-trips the <created_at>|<id> cursor and rejects malformed ones', () => {
    const encoded = encodeCursor({ created_at: 1_700_000_000_000, id: 'abc' });
    expect(encoded).toBe('1700000000000|abc');
    expect(parseCursor(encoded)).toEqual({ createdAt: 1_700_000_000_000, id: 'abc' });
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor('')).toBeNull();
    expect(parseCursor('garbage')).toBeNull();
    expect(parseCursor('|abc')).toBeNull();
    expect(parseCursor('1700000000000|')).toBeNull();
    expect(parseCursor('not-a-number|abc')).toBeNull();
    // Only the first separator splits, so an id containing '|' survives.
    expect(parseCursor('1700000000000|a|b')?.id).toBe('a|b');
  });
});

describe('logs: keyset pagination across tied timestamps (C8)', () => {
  it('never skips or duplicates a row when every row shares one created_at', () => {
    const shared = 1_800_000_000_000;
    // ids chosen so that the descending key order is e > d > c > b > a
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      insert({ id, createdAt: shared, status: 200 });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = listRequestLogs({ limit: 2, cursor });
      seen.push(...result.data.map((row) => row.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(new Set(seen).size).toBe(5);
  });

  it('pages strict-descending rows and reports the final nextCursor as null', () => {
    const base = 1_800_000_000_000;
    for (let index = 0; index < 4; index += 1) {
      insert({ createdAt: base + index * 1_000 });
    }
    const first = listRequestLogs({ limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = listRequestLogs({ limit: 3, cursor: first.nextCursor });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.data[0]?.createdAt).toBe(new Date(base).toISOString());
  });
});

describe('logs: filters are parameterised (defensive)', () => {
  it('does not execute SQL smuggled through model or cursor', () => {
    insert({ model: 'claude-3' });
    const injected = listRequestLogs({ model: "' OR 1=1 --" });
    expect(injected.data).toHaveLength(0);

    const byCursor = listRequestLogs({ cursor: "1|abc' OR 1=1 --" });
    // The cursor is compared, not concatenated: no rows and no throw.
    expect(byCursor.data).toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });

  it('ignores a non-numeric status instead of failing', () => {
    insert({ status: 200 });
    insert({ status: 500 });
    expect(listRequestLogs({ status: 'abc' }).data).toHaveLength(2);
    expect(listRequestLogs({ status: '500' }).data).toHaveLength(1);
  });

  it('counts rows at or after the given instant (inclusive)', () => {
    const start = 1_800_000_000_000;
    insert({ createdAt: start - 1 });
    insert({ createdAt: start });
    insert({ createdAt: start + 1 });
    expect(countRequestLogsSince(start)).toBe(2);
    expect(countRequestLogsSince(start + 2)).toBe(0);
  });
});

describe('stats: range windows (C7)', () => {
  const NOW = Date.UTC(2025, 0, 15, 12, 34, 56); // fixed reference instant

  it('normalises unknown ranges to 7d', () => {
    expect(normalizeStatsRange('24h')).toBe('24h');
    expect(normalizeStatsRange('7d')).toBe('7d');
    expect(normalizeStatsRange('30d')).toBe('30d');
    expect(normalizeStatsRange('1y')).toBe('7d');
    expect(normalizeStatsRange(null)).toBe('7d');
    expect(normalizeStatsRange('')).toBe('7d');
  });

  it('includes a row exactly at the window start and excludes the row before it', () => {
    const windowStart = Math.floor(NOW / DAY_MS) * DAY_MS - 6 * DAY_MS;
    insert({ createdAt: windowStart, model: 'edge-in' });
    insert({ createdAt: windowStart - 1, model: 'edge-out' });
    insert({ createdAt: NOW, model: 'now' });

    const stats = computeStats('7d', NOW);
    expect(stats.range).toBe('7d');
    expect(stats.series).toHaveLength(7);
    expect(stats.totals.requests).toBe(2);
    expect(stats.byModel.map((entry) => entry.model).sort()).toEqual(['edge-in', 'now']);
    expect(stats.series.reduce((sum, point) => sum + point.requests, 0)).toBe(2);

    const rowCount = queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM request_logs WHERE created_at >= ?',
      [windowStart],
    );
    expect(stats.totals.requests).toBe(Number(rowCount?.count));
  });

  it('emits one dense UTC bucket per hour for 24h and per day otherwise', () => {
    const now = NOW;
    const lastHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const firstHourStart = lastHourStart - 23 * HOUR_MS;
    insert({ createdAt: firstHourStart, status: 200 });
    insert({ createdAt: lastHourStart + 1, status: 500 });

    const day = computeStats('24h', now);
    expect(day.series).toHaveLength(24);
    expect(day.series[0]?.t).toBe(new Date(firstHourStart).toISOString());
    expect(day.series[23]?.t).toBe(new Date(lastHourStart).toISOString());
    expect(day.series[23]?.t.endsWith(':00:00.000Z')).toBe(true);
    expect(day.series[0]?.requests).toBe(1);
    expect(day.series[23]?.requests).toBe(1);
    expect(day.series[23]?.errors).toBe(1);
    expect(day.totals.requests).toBe(2);

    const week = computeStats('7d', now);
    const month = computeStats('30d', now);
    expect(week.series).toHaveLength(7);
    expect(month.series).toHaveLength(30);
    expect(month.series[0]?.t).toBe(new Date(Math.floor(now / DAY_MS) * DAY_MS - 29 * DAY_MS).toISOString());
    for (const point of month.series) {
      expect(point.t).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
  });

  it('zero-fills empty buckets and rounds aggregates predictably', () => {
    insert({ createdAt: NOW - 1_000, status: 200, latencyMs: 1, inputTokens: 5, outputTokens: 7 });
    insert({ createdAt: NOW - 500, status: 500, latencyMs: 2, inputTokens: 5, outputTokens: 7 });
    insert({ createdAt: NOW - 250, status: 200, latencyMs: 3, inputTokens: 0, outputTokens: 0 });

    const stats = computeStats('7d', NOW);
    expect(stats.totals).toEqual({
      requests: 3,
      inputTokens: 10,
      outputTokens: 14,
      errorRate: 0.3333,
      avgLatencyMs: 2,
    });
    const nonEmpty = stats.series.filter((point) => point.requests > 0);
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0]?.requests).toBe(3);
    expect(nonEmpty[0]?.errors).toBe(1);
    expect(Number.isInteger(stats.totals.avgLatencyMs)).toBe(true);
  });

  it('groups unknown models under "unknown" and joins key names', () => {
    createApiKey('stats-shape', 'key-shape');
    insert({ createdAt: NOW - 10, model: null, apiKeyId: 'key-shape', status: 200 });
    insert({ createdAt: NOW - 20, model: 'claude-3', apiKeyId: 'key-shape', status: 200 });
    insert({ createdAt: NOW - 30, model: 'claude-3', apiKeyId: 'ghost', status: 200 });

    const stats = computeStats('7d', NOW);
    expect(stats.byModel).toEqual([
      { model: 'claude-3', requests: 2, inputTokens: 2, outputTokens: 4 },
      { model: 'unknown', requests: 1, inputTokens: 1, outputTokens: 2 },
    ]);
    expect(stats.byKey.find((entry) => entry.apiKeyId === 'key-shape')).toEqual({
      apiKeyId: 'key-shape',
      name: 'stats-shape',
      requests: 2,
    });
    expect(stats.byKey.find((entry) => entry.apiKeyId === 'ghost')?.name).toBe('unknown');
    expect(stats.byModel.reduce((sum, entry) => sum + entry.requests, 0)).toBe(stats.totals.requests);
    expect(stats.byKey.reduce((sum, entry) => sum + entry.requests, 0)).toBe(stats.totals.requests);
  });

  it('reports zeros on an empty table', () => {
    const stats = computeStats('24h', NOW);
    expect(stats.totals).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      errorRate: 0,
      avgLatencyMs: 0,
    });
    expect(stats.series).toHaveLength(24);
    expect(stats.series.every((point) => point.requests === 0 && point.errors === 0)).toBe(true);
    expect(stats.byModel).toEqual([]);
    expect(stats.byKey).toEqual([]);
  });
});
