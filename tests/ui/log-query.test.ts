import { describe, expect, it } from 'vitest';
import {
  LOG_PAGE_SIZE,
  STATUS_FILTER_OPTIONS,
  buildLogsQuery,
  buildStatsQuery,
  filtersChanged,
  mergeLogPages,
  normalizeModelFilter,
  normalizePageSize,
  normalizeStatusFilter,
  parseNextCursor,
} from '@/components/console/log-query';
import type { RequestLogPublic } from '@/components/console/types';

function row(id: string): RequestLogPublic {
  return {
    id,
    createdAt: '2025-01-01T00:00:00.000Z',
    protocol: 'anthropic',
    path: '/v1/messages',
    model: 'claude-sonnet-4-5',
    upstream: 'https://api.anthropic.com',
    status: 200,
    latencyMs: 120,
    inputTokens: 10,
    outputTokens: 20,
    apiKeyId: 'key-1',
    error: null,
    stream: false,
  };
}

describe('normalizeStatusFilter', () => {
  it('keeps only a plausible HTTP status code', () => {
    expect(normalizeStatusFilter('200')).toBe('200');
    expect(normalizeStatusFilter(' 502 ')).toBe('502');
    expect(normalizeStatusFilter('99')).toBe('');
    expect(normalizeStatusFilter('600')).toBe('');
    expect(normalizeStatusFilter('abc')).toBe('');
    expect(normalizeStatusFilter('')).toBe('');
    expect(normalizeStatusFilter(null)).toBe('');
    expect(normalizeStatusFilter(undefined)).toBe('');
  });

  it('offers a curated list of common statuses', () => {
    expect(STATUS_FILTER_OPTIONS).toContain('200');
    expect(STATUS_FILTER_OPTIONS).toContain('401');
    expect(STATUS_FILTER_OPTIONS).toContain('502');
  });
});

describe('normalizeModelFilter', () => {
  it('trims, strips control characters and caps the length', () => {
    expect(normalizeModelFilter('  claude-3-5-sonnet  ')).toBe('claude-3-5-sonnet');
    expect(normalizeModelFilter('a\u0000b')).toBe('ab');
    expect(normalizeModelFilter('x'.repeat(200)).length).toBe(128);
    expect(normalizeModelFilter(null)).toBe('');
  });
});

describe('normalizePageSize', () => {
  it('clamps into the range the API accepts', () => {
    expect(normalizePageSize(10)).toBe(10);
    expect(normalizePageSize(0)).toBe(LOG_PAGE_SIZE);
    expect(normalizePageSize(-4)).toBe(LOG_PAGE_SIZE);
    expect(normalizePageSize('25')).toBe(25);
    expect(normalizePageSize(9999)).toBe(200);
    expect(normalizePageSize('nope')).toBe(LOG_PAGE_SIZE);
  });
});

describe('buildLogsQuery', () => {
  it('sends only the limit when there is nothing to filter', () => {
    expect(buildLogsQuery({ limit: 50 })).toBe('?limit=50');
  });

  it('is empty when no parameter is set', () => {
    expect(buildLogsQuery()).toBe('');
    expect(buildLogsQuery({ status: '', model: '' })).toBe('');
  });

  it('percent-encodes the cursor so the pipe survives', () => {
    const query = buildLogsQuery({ limit: 50, cursor: '1700000000000|row-1' });
    expect(query).toContain('cursor=1700000000000%7Crow-1');
    const parsed = new URLSearchParams(query.slice(1));
    expect(parsed.get('cursor')).toBe('1700000000000|row-1');
  });

  it('encodes the model and drops an invalid status', () => {
    const query = buildLogsQuery({ status: 'abc', model: 'claude sonnet/4.5' });
    const parsed = new URLSearchParams(query.slice(1));
    expect(parsed.get('status')).toBeNull();
    expect(parsed.get('model')).toBe('claude sonnet/4.5');
  });

  it('round-trips every field the logs page sends', () => {
    const query = buildLogsQuery({ limit: 50, cursor: '1|a', status: '429', model: 'gpt-4o-mini' });
    const parsed = new URLSearchParams(query.slice(1));
    expect(parsed.get('limit')).toBe('50');
    expect(parsed.get('cursor')).toBe('1|a');
    expect(parsed.get('status')).toBe('429');
    expect(parsed.get('model')).toBe('gpt-4o-mini');
  });
});

describe('buildStatsQuery', () => {
  it('always sends a supported range', () => {
    expect(buildStatsQuery('24h')).toBe('?range=24h');
    expect(buildStatsQuery('30d')).toBe('?range=30d');
  });
});

describe('parseNextCursor', () => {
  it('accepts only a non-empty string', () => {
    expect(parseNextCursor('1|a')).toBe('1|a');
    expect(parseNextCursor('  1|a  ')).toBe('1|a');
    expect(parseNextCursor('')).toBeNull();
    expect(parseNextCursor(null)).toBeNull();
    expect(parseNextCursor(undefined)).toBeNull();
    expect(parseNextCursor(42)).toBeNull();
    expect(parseNextCursor({})).toBeNull();
  });
});

describe('mergeLogPages', () => {
  it('appends new rows and drops ids that are already present', () => {
    const merged = mergeLogPages([row('a'), row('b')], [row('b'), row('c')]);
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the existing page', () => {
    const existing = [row('a')];
    const merged = mergeLogPages(existing, [row('b')]);
    expect(existing).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });

  it('returns the same rows for an empty page', () => {
    expect(mergeLogPages([row('a')], [])).toHaveLength(1);
    expect(mergeLogPages([], [])).toEqual([]);
  });
});

describe('filtersChanged', () => {
  it('detects a changed status or model', () => {
    expect(filtersChanged({ status: '', model: '' }, { status: '200', model: '' })).toBe(true);
    expect(filtersChanged({ status: '', model: 'a' }, { status: '', model: 'b' })).toBe(true);
    expect(filtersChanged({ status: '200', model: 'a' }, { status: '200', model: 'a' })).toBe(false);
  });
});
