import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHART_LAYOUT,
  CHART_METRICS,
  buildSeriesGeometry,
  buildTicks,
  metricValue,
  niceCeil,
  pickLabelIndexes,
  pickMetricValues,
} from '@/components/console/chart';
import type { StatsSeriesPoint } from '@/components/console/types';

function point(t: string, requests: number, inputTokens = 0, outputTokens = 0, errors = 0): StatsSeriesPoint {
  return { t, requests, inputTokens, outputTokens, errors };
}

const SERIES: StatsSeriesPoint[] = [
  point('2025-01-01T00:00:00.000Z', 0),
  point('2025-01-01T01:00:00.000Z', 10, 100, 50, 1),
  point('2025-01-01T02:00:00.000Z', 30, 300, 150, 0),
  point('2025-01-01T03:00:00.000Z', 20, 200, 100, 2),
];

describe('niceCeil', () => {
  it('rounds up to a readable axis maximum', () => {
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(12)).toBe(20);
    expect(niceCeil(23)).toBe(25);
    expect(niceCeil(31)).toBe(50);
    expect(niceCeil(80)).toBe(100);
    expect(niceCeil(1234)).toBe(2000);
  });

  it('never returns zero or a negative axis', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    expect(niceCeil(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('buildTicks', () => {
  it('spans zero to the maximum inclusive', () => {
    expect(buildTicks(100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('falls back to a single interval for a degenerate maximum', () => {
    expect(buildTicks(0, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(buildTicks(10, 0)).toEqual([0, 10]);
  });
});

describe('pickLabelIndexes', () => {
  it('returns every index when they all fit', () => {
    expect(pickLabelIndexes(3, 6)).toEqual([0, 1, 2]);
  });

  it('spreads labels evenly and always includes the last bucket', () => {
    const indexes = pickLabelIndexes(24, 6);
    expect(indexes.length).toBeLessThanOrEqual(6);
    expect(indexes[0]).toBe(0);
    expect(indexes[indexes.length - 1]).toBe(23);
  });

  it('is empty for an empty series', () => {
    expect(pickLabelIndexes(0)).toEqual([]);
  });
});

describe('metricValue / pickMetricValues', () => {
  it('coerces missing, negative and non-finite values to zero', () => {
    expect(metricValue(point('t', -3), 'requests')).toBe(0);
    expect(metricValue(point('t', Number.NaN), 'requests')).toBe(0);
    const partial = { t: 't', requests: 1 } as unknown as StatsSeriesPoint;
    expect(metricValue(partial, 'inputTokens')).toBe(0);
  });

  it('extracts a metric across the series', () => {
    expect(pickMetricValues(SERIES, 'requests')).toEqual([0, 10, 30, 20]);
    expect(pickMetricValues(SERIES, 'errors')).toEqual([0, 1, 0, 2]);
  });

  it('exposes exactly the four chartable metrics', () => {
    expect(CHART_METRICS).toEqual(['requests', 'inputTokens', 'outputTokens', 'errors']);
  });
});

describe('buildSeriesGeometry', () => {
  it('produces one point per bucket with in-bounds coordinates', () => {
    const geometry = buildSeriesGeometry(SERIES, 'requests');
    expect(geometry.points).toHaveLength(SERIES.length);
    const { paddingLeft, paddingRight, paddingTop, paddingBottom, width, height } = DEFAULT_CHART_LAYOUT;
    for (const candidate of geometry.points) {
      expect(candidate.x).toBeGreaterThanOrEqual(paddingLeft);
      expect(candidate.x).toBeLessThanOrEqual(width - paddingRight + 0.01);
      expect(candidate.y).toBeGreaterThanOrEqual(paddingTop - 0.01);
      expect(candidate.y).toBeLessThanOrEqual(height - paddingBottom + 0.01);
    }
  });

  it('anchors the highest value at the top padding and zero at the baseline', () => {
    const geometry = buildSeriesGeometry(SERIES, 'requests');
    const zero = geometry.points[0];
    const peak = geometry.points[2];
    // Zero sits on the baseline; the peak is plotted against the rounded axis
    // maximum (niceCeil(30) === 50), so it stays below the top padding.
    expect(zero?.y).toBeCloseTo(geometry.baselineY, 1);
    expect(geometry.max).toBe(50);
    const { paddingTop, paddingBottom, height } = DEFAULT_CHART_LAYOUT;
    const innerHeight = height - paddingTop - paddingBottom;
    expect(peak?.y).toBeCloseTo(geometry.baselineY - innerHeight * (30 / geometry.max), 1);
    expect(peak?.y).toBeGreaterThanOrEqual(paddingTop);
  });

  it('builds an M/L path and a closed area path', () => {
    const geometry = buildSeriesGeometry(SERIES, 'requests');
    expect(geometry.linePath.startsWith('M ')).toBe(true);
    expect(geometry.linePath.split('L').length - 1).toBe(SERIES.length - 1);
    expect(geometry.areaPath.endsWith('Z')).toBe(true);
    expect(geometry.areaPath).toContain(geometry.linePath);
  });

  it('reports the peak and the window total', () => {
    const geometry = buildSeriesGeometry(SERIES, 'inputTokens');
    expect(geometry.peak).toBe(300);
    expect(geometry.total).toBe(600);
  });

  it('never emits NaN for an all-zero series', () => {
    const empty = [point('2025-01-01T00:00:00.000Z', 0), point('2025-01-01T01:00:00.000Z', 0)];
    const geometry = buildSeriesGeometry(empty, 'requests');
    expect(geometry.peak).toBe(0);
    expect(geometry.max).toBe(1);
    expect(geometry.linePath).not.toContain('NaN');
    expect(geometry.baselineY).toBeGreaterThan(0);
  });

  it('handles an empty series and a single bucket without NaN', () => {
    const none = buildSeriesGeometry([], 'requests');
    expect(none.points).toEqual([]);
    expect(none.linePath).toBe('');
    expect(none.areaPath).toBe('');

    const single = buildSeriesGeometry([point('2025-01-01T00:00:00.000Z', 5)], 'requests');
    expect(single.points).toHaveLength(1);
    expect(single.linePath).not.toContain('NaN');
    expect(single.areaPath).toBe('');
  });

  it('keeps a flat series on the baseline', () => {
    const flat = [point('t1', 4), point('t2', 4), point('t3', 4)];
    const geometry = buildSeriesGeometry(flat, 'requests');
    const ys = geometry.points.map((candidate) => candidate.y);
    expect(new Set(ys).size).toBe(1);
  });
});
