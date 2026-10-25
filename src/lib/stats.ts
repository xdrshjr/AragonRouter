import { queryAll, queryOne, type SqliteValue } from '@/lib/db';
import type {
  StatsByKey,
  StatsByModel,
  StatsPayload,
  StatsRange,
  StatsSeriesPoint,
  StatsTotals,
} from '@/lib/types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const STATS_RANGES: readonly StatsRange[] = ['24h', '7d', '30d'] as const;
export const DEFAULT_STATS_RANGE: StatsRange = '7d';

interface RangeConfig {
  bucket: 'hour' | 'day';
  buckets: number;
  bucketMs: number;
}

const RANGE_CONFIG: Record<StatsRange, RangeConfig> = {
  '24h': { bucket: 'hour', buckets: 24, bucketMs: HOUR_MS },
  '7d': { bucket: 'day', buckets: 7, bucketMs: DAY_MS },
  '30d': { bucket: 'day', buckets: 30, bucketMs: DAY_MS },
};

/** Coerce an arbitrary query value into a supported range (defaults to `7d`). */
export function normalizeStatsRange(value: unknown): StatsRange {
  if (value === '24h' || value === '7d' || value === '30d') return value;
  return DEFAULT_STATS_RANGE;
}

function toNumber(value: SqliteValue | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function floorTo(ms: number, unit: number): number {
  return Math.floor(ms / unit) * unit;
}

/** SQLite bucket expression matching {@link bucketKey}. */
function sqlBucket(config: RangeConfig): string {
  const format = config.bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';
  return `strftime('${format}', created_at / 1000, 'unixepoch')`;
}

function bucketKey(bucketStartMs: number, bucket: 'hour' | 'day'): string {
  const iso = new Date(bucketStartMs).toISOString();
  return bucket === 'hour' ? `${iso.slice(0, 13)}:00:00Z` : iso.slice(0, 10);
}

interface Window {
  config: RangeConfig;
  startMs: number;
  bucketStarts: number[];
}

function buildWindow(range: StatsRange, now: number): Window {
  const config = RANGE_CONFIG[range];
  const lastBucketStart = floorTo(now, config.bucketMs);
  const bucketStarts: number[] = [];
  for (let index = config.buckets - 1; index >= 0; index -= 1) {
    bucketStarts.push(lastBucketStart - index * config.bucketMs);
  }
  const startMs = bucketStarts[0] ?? lastBucketStart;
  return { config, startMs, bucketStarts };
}

/**
 * Aggregate request logs for the console dashboard (C7).
 *
 * `totals.requests` is a plain `COUNT(*)` over the same window as the series, so
 * it always equals the number of `request_logs` rows in the range.
 * Buckets are aligned to UTC hours (`24h`) or UTC days (`7d` / `30d`) and the
 * series is dense (empty buckets are zero-filled).
 */
export function computeStats(range: StatsRange, now: number = Date.now()): StatsPayload {
  const window = buildWindow(range, now);
  const { config, startMs, bucketStarts } = window;

  const totalsRow = queryOne<Record<string, SqliteValue>>(
    `SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
      FROM request_logs WHERE created_at >= ?`,
    [startMs],
  );

  const requests = toNumber(totalsRow?.requests);
  const errors = toNumber(totalsRow?.errors);
  const totals: StatsTotals = {
    requests,
    inputTokens: toNumber(totalsRow?.inputTokens),
    outputTokens: toNumber(totalsRow?.outputTokens),
    errorRate: requests > 0 ? Number((errors / requests).toFixed(4)) : 0,
    avgLatencyMs: Math.round(toNumber(totalsRow?.avgLatencyMs)),
  };

  const bucketExpr = sqlBucket(config);
  const bucketRows = queryAll<Record<string, SqliteValue>>(
    `SELECT
        ${bucketExpr} AS bucket,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
      FROM request_logs WHERE created_at >= ?
      GROUP BY bucket ORDER BY bucket ASC`,
    [startMs],
  );

  const byBucket = new Map<string, StatsSeriesPoint>();
  for (const row of bucketRows) {
    const key = typeof row.bucket === 'string' ? row.bucket : '';
    if (!key) continue;
    byBucket.set(key, {
      t: key,
      requests: toNumber(row.requests),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      errors: toNumber(row.errors),
    });
  }

  const series: StatsSeriesPoint[] = bucketStarts.map((bucketStart) => {
    const key = bucketKey(bucketStart, config.bucket);
    const existing = byBucket.get(key);
    // Always emit the bucket start as a full ISO string so the series has a
    // uniform shape regardless of whether the bucket had traffic.
    return {
      t: new Date(bucketStart).toISOString(),
      requests: existing?.requests ?? 0,
      inputTokens: existing?.inputTokens ?? 0,
      outputTokens: existing?.outputTokens ?? 0,
      errors: existing?.errors ?? 0,
    };
  });

  const byModel = queryAll<Record<string, SqliteValue>>(
    `SELECT
        COALESCE(NULLIF(model, ''), 'unknown') AS model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM request_logs WHERE created_at >= ?
      GROUP BY model ORDER BY requests DESC, model ASC`,
    [startMs],
  ).map<StatsByModel>((row) => ({
    model: typeof row.model === 'string' && row.model.length > 0 ? row.model : 'unknown',
    requests: toNumber(row.requests),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
  }));

  const byKey = queryAll<Record<string, SqliteValue>>(
    `SELECT
        l.api_key_id AS apiKeyId,
        k.name AS name,
        COUNT(*) AS requests
      FROM request_logs l
      LEFT JOIN api_keys k ON k.id = l.api_key_id
      WHERE l.created_at >= ?
      GROUP BY l.api_key_id ORDER BY requests DESC`,
    [startMs],
  ).map<StatsByKey>((row) => ({
    apiKeyId: typeof row.apiKeyId === 'string' ? row.apiKeyId : null,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'unknown',
    requests: toNumber(row.requests),
  }));

  return { range, totals, series, byModel, byKey };
}
