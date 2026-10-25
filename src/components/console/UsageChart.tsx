'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import {
  DEFAULT_CHART_LAYOUT,
  buildSeriesGeometry,
  isHourlyRange,
  type ChartMetric,
} from '@/components/console/chart';
import { formatBucketLabel, formatCompactNumber, formatNumber, formatPercent } from '@/components/console/format';
import type { StatsPayload, StatsRange } from '@/components/console/types';

const METRIC_ITEMS: readonly { value: ChartMetric; label: string }[] = [
  { value: 'requests', label: 'Requests' },
  { value: 'inputTokens', label: 'Input tokens' },
  { value: 'outputTokens', label: 'Output tokens' },
  { value: 'errors', label: 'Errors' },
];

export interface UsageChartProps {
  stats: StatsPayload;
  className?: string;
}

/**
 * Usage over time - inline SVG only (no chart library allowed by the spec).
 *
 * Every coordinate comes from `buildSeriesGeometry`, which is unit tested, so this
 * component stays a pure renderer. The chart is `role="img"` with a text summary
 * that states the total and the peak, which is what a screen reader needs.
 */
export function UsageChart({ stats, className }: UsageChartProps): ReactNode {
  const [metric, setMetric] = useState<ChartMetric>('requests');
  const range: StatsRange = stats.range;

  const geometry = useMemo(
    () => buildSeriesGeometry(stats.series, metric, DEFAULT_CHART_LAYOUT),
    [stats.series, metric],
  );

  const layout = DEFAULT_CHART_LAYOUT;
  const metricLabel = METRIC_ITEMS.find((item) => item.value === metric)?.label ?? 'Requests';
  const bucketLabel = isHourlyRange(range) ? 'hourly' : 'daily';
  const isEmpty = geometry.points.length === 0 || geometry.peak === 0;

  const summary =
    geometry.points.length === 0
      ? `No ${bucketLabel} buckets in the selected range.`
      : `${metricLabel} over ${bucketLabel} buckets: ${formatNumber(geometry.total)} in total, peak ${formatNumber(geometry.peak)}.`;

  const ariaId = `usage-chart-summary-${metric}`;

  return (
    <Card className={cn('flex flex-col gap-3', className)}>
      <CardHeader
        actions={
          <Tabs
            items={METRIC_ITEMS}
            value={metric}
            onChange={(value) => {
              setMetric(value);
            }}
            label="Chart metric"
          />
        }
      >
        <CardTitle eyebrow="Usage" description={`Traffic per ${bucketLabel} bucket for the last ${range}.`}>
          {metricLabel} over time
        </CardTitle>
      </CardHeader>

      <figure className="m-0">
        <p id={ariaId} className="sr-only">
          {summary}
        </p>
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="h-56 w-full"
          role="img"
          aria-labelledby={ariaId}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Horizontal grid + value labels */}
          {geometry.ticks.map((tick, index) => {
            const ratio = geometry.max > 0 ? tick / geometry.max : 0;
            const innerHeight = layout.height - layout.paddingTop - layout.paddingBottom;
            const y = layout.paddingTop + innerHeight * (1 - ratio);
            return (
              <g key={`tick-${index}`}>
                <line
                  x1={layout.paddingLeft}
                  x2={layout.width - layout.paddingRight}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth="1"
                  strokeDasharray={index === 0 ? undefined : '2 4'}
                />
                <text
                  x={layout.paddingLeft - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--text-muted)"
                >
                  {formatCompactNumber(tick)}
                </text>
              </g>
            );
          })}

          {/* Area + line */}
          {!isEmpty && geometry.areaPath ? (
            <path d={geometry.areaPath} fill="url(#usage-area)" stroke="none" />
          ) : null}
          {!isEmpty ? (
            <path
              d={geometry.linePath}
              fill="none"
              stroke="var(--brand)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* Data points with a tooltip on hover */}
          {!isEmpty
            ? geometry.points.map((point, index) => (
                <circle
                  key={`point-${index}`}
                  cx={point.x}
                  cy={point.y}
                  r={2.5}
                  fill="var(--surface)"
                  stroke="var(--brand)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>
                    {`${formatBucketLabel(point.t, range)} · ${formatNumber(point.value)} ${metricLabel.toLowerCase()}`}
                  </title>
                </circle>
              ))
            : null}

          {/* X axis labels */}
          {geometry.labelIndexes.map((index) => {
            const point = geometry.points[index];
            if (!point) return null;
            return (
              <text
                key={`label-${index}`}
                x={point.x}
                y={layout.height - 8}
                textAnchor={index === 0 ? 'start' : index === geometry.points.length - 1 ? 'end' : 'middle'}
                fontSize="10"
                fill="var(--text-muted)"
              >
                {formatBucketLabel(point.t, range)}
              </text>
            );
          })}
        </svg>

        {isEmpty ? (
          <EmptyState
            compact
            title="No traffic in this range"
            description="The chart fills in as soon as the relay serves a request."
          />
        ) : null}

        <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-4 text-muted">
          <span className="tabular">
            Total <span className="text-text">{formatNumber(geometry.total)}</span>
          </span>
          <span className="tabular">
            Peak <span className="text-text">{formatNumber(geometry.peak)}</span>
          </span>
          <span className="tabular">
            Error rate <span className="text-text">{formatPercent(stats.totals.errorRate)}</span>
          </span>
        </figcaption>
      </figure>
    </Card>
  );
}
