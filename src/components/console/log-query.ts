/**
 * Pure query-string builders for the C7/C8 endpoints.
 *
 * Kept free of React and of `fetch` so `tests/ui/log-query.test.ts` can exercise
 * the exact strings the console sends (cursor encoding is the fragile part: the
 * C8 cursor is `<created_at>|<id>` and the pipe must survive URL encoding).
 */

import type { RequestLogPublic, StatsRange } from '@/components/console/types';

/** Default page size for the logs table (C8 default is 50, max 200). */
export const LOG_PAGE_SIZE = 50;

/** Status codes offered by the logs filter. C8 matches `status` exactly. */
export const STATUS_FILTER_OPTIONS: readonly string[] = [
  '200',
  '400',
  '401',
  '404',
  '413',
  '429',
  '500',
  '502',
  '503',
];

/**
 * Normalise the status filter to either '' (no filter) or a decimal integer.
 * Anything else would be silently ignored by the server, so it is dropped here
 * instead of producing a confusing "no rows" table.
 */
export function normalizeStatusFilter(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return '';
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 599) return '';
  return String(parsed);
}

/** Trim the model filter and cap it at the provider/model length limit. */
export function normalizeModelFilter(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128);
}

/** Clamp a page size into the range the API accepts (1-200). */
export function normalizePageSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return LOG_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

export interface LogsQueryInput {
  limit?: number | string | null;
  cursor?: string | null;
  status?: string | null;
  model?: string | null;
}

/**
 * Build the `GET /api/admin/logs` query string, including the leading `?`.
 * Returns `''` when nothing needs to be sent. The cursor is percent-encoded so
 * its `|` separator and any legacy id characters reach the server intact.
 */
export function buildLogsQuery(input: LogsQueryInput = {}): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined && input.limit !== null && String(input.limit).trim() !== '') {
    params.set('limit', String(normalizePageSize(input.limit)));
  }
  const cursor = typeof input.cursor === 'string' ? input.cursor.trim() : '';
  if (cursor.length > 0) params.set('cursor', cursor);
  const status = normalizeStatusFilter(input.status ?? '');
  if (status.length > 0) params.set('status', status);
  const model = normalizeModelFilter(input.model ?? '');
  if (model.length > 0) params.set('model', model);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** Build the `GET /api/admin/stats` query string. */
export function buildStatsQuery(range: StatsRange): string {
  const params = new URLSearchParams();
  params.set('range', range);
  return `?${params.toString()}`;
}

/**
 * Read `nextCursor` defensively: only a non-empty string continues pagination.
 * Anything else (null, undefined, `''`, a number from a broken proxy) stops it,
 * so the UI can never loop on a malformed cursor.
 */
export function parseNextCursor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Append a page of log rows, dropping rows already present.
 * C8 paginates on `(created_at, id)`; a concurrent write between two requests can
 * therefore repeat a row, and a duplicate React key would break the table.
 */
export function mergeLogPages(
  existing: readonly RequestLogPublic[],
  incoming: readonly RequestLogPublic[],
): RequestLogPublic[] {
  const seen = new Set(existing.map((row) => row.id));
  const merged = [...existing];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

/**
 * True when the active filters differ from the ones the current rows were loaded
 * with, i.e. the table must reset instead of appending.
 */
export function filtersChanged(
  previous: { status: string; model: string },
  next: { status: string; model: string },
): boolean {
  return previous.status !== next.status || previous.model !== next.model;
}
