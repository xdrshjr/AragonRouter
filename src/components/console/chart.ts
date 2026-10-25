/**
 * Inline-SVG geometry for the overview usage chart (no chart library is allowed).
 *
 * Everything here is pure arithmetic over the C7 `series`, so the shapes can be
 * unit-tested without a DOM: `tests/ui/chart.test.ts` checks the produced paths.
 */

import type { StatsRange, StatsSeriesPoint } from '@/components/console/types';

/** Which `series` field the chart draws. */
export type ChartMetric = 'requests' | 'inputTokens' | 'outputTokens' | 'errors';

export const CHART_METRICS: readonly ChartMetric[] = [
  'requests',
  'inputTokens',
  'outputTokens',
  'errors',
];

export interface ChartLayout {
  width: number;
  height: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
}

export const DEFAULT_CHART_LAYOUT: ChartLayout = {
  width: 720,
  height: 240,
  paddingTop: 16,
  paddingRight: 16,
  paddingBottom: 28,
  paddingLeft: 44,
};

export interface ChartPoint {
  /** Bucket timestamp (ISO). */
  t: string;
  /** Raw metric value. */
  value: number;
  /** SVG x coordinate. */
  x: number;
  /** SVG y coordinate (0 at the top). */
  y: number;
}

export interface ChartGeometry {
  points: ChartPoint[];
  /** Top of the value axis; always a "nice" number >= the largest value. */
  max: number;
  /** Horizontal grid lines to render, from 0 to max. */
  ticks: number[];
  /** `M ... L ...` line path, empty when there is nothing to draw. */
  linePath: string;
  /** Same path closed against the baseline, empty when nothing to draw. */
  areaPath: string;
  /** Y coordinate of the zero baseline. */
  baselineY: number;
  /** Indexes into `points` where an x-axis label fits without overlapping. */
  labelIndexes: number[];
  /** Largest raw value in the series. */
  peak: number;
  /** Sum of the drawn metric over the window. */
  total: number;
}

const EMPTY_GEOMETRY: ChartGeometry = {
  points: [],
  max: 0,
  ticks: [],
  linePath: '',
  areaPath: '',
  baselineY: 0,
  labelIndexes: [],
  peak: 0,
  total: 0,
};

/** Read one metric out of a series point. */
export function metricValue(point: StatsSeriesPoint, metric: ChartMetric): number {
  const raw = point[metric];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Extract the plotted values in bucket order. */
export function pickMetricValues(
  series: readonly StatsSeriesPoint[],
  metric: ChartMetric,
): number[] {
  return series.map((point) => metricValue(point, metric));
}

/**
 * Round an axis maximum up to 1/2/2.5/5 x 10^n so ticks are readable integers.
 * `0` maps to `1` so the chart still renders an empty grid with a zero baseline.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Evenly spaced tick values from 0 to `max`, always including both ends. */
export function buildTicks(max: number, count = 4): number[] {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const steps = Math.max(1, Math.trunc(count));
  const ticks: number[] = [];
  for (let index = 0; index <= steps; index += 1) {
    ticks.push((safeMax / steps) * index);
  }
  return ticks;
}

/** Choose up to `maxLabels` evenly spaced bucket indexes for the x axis. */
export function pickLabelIndexes(length: number, maxLabels = 6): number[] {
  if (length <= 0) return [];
  const slots = Math.max(1, Math.trunc(maxLabels));
  if (length <= slots) return Array.from({ length }, (_unused, index) => index);
  const stride = (length - 1) / (slots - 1);
  const indexes: number[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const index = Math.round(slot * stride);
    if (!indexes.includes(index)) indexes.push(index);
  }
  return indexes;
}

/**
 * Turn one C7 series into SVG geometry.
 * Returns an empty geometry (no paths) for an empty series and a flat line for a
 * single bucket, so the caller never has to special-case `NaN` coordinates.
 */
export function buildSeriesGeometry(
  series: readonly StatsSeriesPoint[],
  metric: ChartMetric,
  layout: ChartLayout = DEFAULT_CHART_LAYOUT,
): ChartGeometry {
  if (series.length === 0) return EMPTY_GEOMETRY;

  const values = pickMetricValues(series, metric);
  const peak = values.reduce((acc, value) => (value > acc ? value : acc), 0);
  const total = values.reduce((acc, value) => acc + value, 0);
  const max = niceCeil(peak);

  const innerWidth = Math.max(1, layout.width - layout.paddingLeft - layout.paddingRight);
  const innerHeight = Math.max(1, layout.height - layout.paddingTop - layout.paddingBottom);
  const baselineY = layout.paddingTop + innerHeight;

  const points: ChartPoint[] = values.map((value, index) => {
    const ratio = series.length === 1 ? 0.5 : index / (series.length - 1);
    const x = layout.paddingLeft + innerWidth * ratio;
    const heightRatio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    const y = baselineY - innerHeight * heightRatio;
    return { t: series[index]?.t ?? '', value, x: round(x), y: round(y) };
  });

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return EMPTY_GEOMETRY;

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const areaPath =
    points.length === 1
      ? ''
      : `${linePath} L ${last.x} ${round(baselineY)} L ${first.x} ${round(baselineY)} Z`;

  return {
    points,
    max,
    ticks: buildTicks(max),
    linePath,
    areaPath,
    baselineY: round(baselineY),
    labelIndexes: pickLabelIndexes(points.length),
    peak,
    total,
  };
}

/** `24h` -> hourly buckets on the axis, `7d`/`30d` -> calendar days (C7 shape). */
export function isHourlyRange(range: StatsRange): boolean {
  return range === '24h';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
