import { newId } from '@/lib/crypto';
import { execute, queryAll, queryOne } from '@/lib/db';
import type { Protocol, RequestLogPublic } from '@/lib/types';

const MODEL_MAX_LENGTH = 200;
const PATH_MAX_LENGTH = 300;
const ERROR_MAX_LENGTH = 1000;
const UPSTREAM_MAX_LENGTH = 200;
export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;

export interface RequestLogInput {
  protocol: Protocol;
  path: string;
  model?: string | null;
  upstream?: string | null;
  status: number;
  latencyMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  apiKeyId?: string | null;
  error?: string | null;
  stream?: boolean;
  createdAt?: number;
  id?: string;
}

export interface RequestLogRow {
  id: string;
  created_at: number;
  protocol: Protocol;
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

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return null;
  return clip(cleaned, max);
}

function optionalTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  return null;
}

/** Persist one proxied request. Returns the row id. */
export function insertRequestLog(input: RequestLogInput): string {
  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? Date.now();
  execute(
    `INSERT INTO request_logs
      (id, created_at, protocol, path, model, upstream, status, latency_ms, input_tokens, output_tokens, api_key_id, error, stream)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      Math.trunc(createdAt),
      input.protocol,
      clip(input.path, PATH_MAX_LENGTH),
      optionalText(input.model, MODEL_MAX_LENGTH),
      optionalText(input.upstream, UPSTREAM_MAX_LENGTH),
      Math.trunc(input.status),
      Math.max(0, Math.trunc(input.latencyMs)),
      optionalTokenCount(input.inputTokens),
      optionalTokenCount(input.outputTokens),
      input.apiKeyId ?? null,
      optionalText(input.error, ERROR_MAX_LENGTH),
      input.stream ? 1 : 0,
    ],
  );
  return id;
}

function toPublic(row: RequestLogRow): RequestLogPublic {
  return {
    id: row.id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    protocol: row.protocol,
    path: row.path,
    model: row.model,
    upstream: row.upstream,
    status: Number(row.status),
    latencyMs: Number(row.latency_ms),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    apiKeyId: row.api_key_id,
    error: row.error,
    stream: Number(row.stream) === 1,
  };
}

export interface ListLogsOptions {
  limit?: number | string | null;
  cursor?: string | null;
  status?: number | string | null;
  model?: string | null;
  protocol?: string | null;
  path?: string | null;
  apiKeyId?: string | null;
}

export interface ListLogsResult {
  data: RequestLogPublic[];
  nextCursor: string | null;
}

export function parseLogLimit(value: ListLogsOptions['limit']): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.trunc(parsed), MAX_LOG_LIMIT);
}

export function encodeCursor(row: { created_at: number; id: string }): string {
  return `${Number(row.created_at)}|${row.id}`;
}

export function parseCursor(cursor: string | null | undefined): { createdAt: number; id: string } | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  const separator = cursor.indexOf('|');
  if (separator <= 0) return null;
  const createdAt = Number.parseInt(cursor.slice(0, separator), 10);
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

/**
 * Keyset paginated log listing (C8). `nextCursor` is `<created_at>|<id>`.
 */
export function listRequestLogs(options: ListLogsOptions = {}): ListLogsResult {
  const limit = parseLogLimit(options.limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const cursor = parseCursor(options.cursor);
  if (cursor) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  if (options.status !== undefined && options.status !== null && String(options.status).trim() !== '') {
    const status = Number.parseInt(String(options.status), 10);
    if (Number.isFinite(status)) {
      conditions.push('status = ?');
      params.push(status);
    }
  }

  if (options.model) {
    conditions.push('model = ?');
    params.push(options.model);
  }

  if (options.protocol) {
    conditions.push('protocol = ?');
    params.push(options.protocol);
  }

  if (options.path) {
    conditions.push('path = ?');
    params.push(options.path);
  }

  if (options.apiKeyId) {
    conditions.push('api_key_id = ?');
    params.push(options.apiKeyId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = queryAll<RequestLogRow>(
    `SELECT * FROM request_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    data: page.map(toPublic),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

/** Number of logged requests since a timestamp - the authoritative `totals.requests`. */
export function countRequestLogsSince(sinceMs: number): number {
  const row = queryOne<{ requests: number }>(
    'SELECT COUNT(*) AS requests FROM request_logs WHERE created_at >= ?',
    [sinceMs],
  );
  return row ? Number(row.requests) : 0;
}
