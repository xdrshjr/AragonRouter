'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, Gauge, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { LogTable } from '@/components/console/LogTable';
import { StatCard, StatCardSkeleton } from '@/components/console/StatCard';
import { UsageChart } from '@/components/console/UsageChart';
import { useAdminQuery } from '@/components/console/use-admin-query';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { getStats, listLogs, isUnauthorized } from '@/components/console/api';
import { formatLatency, formatNumber, formatPercent, formatTokens } from '@/components/console/format';
import { STATS_RANGES, type StatsRange } from '@/components/console/types';

/** How many recent requests the overview card shows. */
const RECENT_LIMIT = 6;

const RANGE_ITEMS = STATS_RANGES.map((range) => ({ value: range, label: range }));

/**
 * `/console` overview (C7 + C8).
 *
 * Four KPI cards, the inline-SVG usage chart and the latest requests. The range
 * selector drives `/api/admin/stats`; the recent list always shows the newest
 * rows because that is what an operator checks first.
 */
export function OverviewPanel(): ReactNode {
  const [range, setRange] = useState<StatsRange>('7d');

  const statsLoader = useCallback(
    (signal: AbortSignal) => getStats(range, signal),
    [range],
  );
  const stats = useAdminQuery(statsLoader, [range]);

  const recentLoader = useCallback(
    (signal: AbortSignal) => listLogs({ limit: RECENT_LIMIT }, signal),
    [],
  );
  const recent = useAdminQuery(recentLoader, []);

  useSessionExpiryRedirect(stats.error);

  const totals = stats.data?.totals ?? null;
  const tokenTotal = useMemo(() => {
    if (!totals) return 0;
    return totals.inputTokens + totals.outputTokens;
  }, [totals]);

  const reloadAll = useCallback(() => {
    stats.refresh();
    recent.refresh();
  }, [recent, stats]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">Overview</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Relay activity</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Traffic that passed through <span className="mono text-text">/api/v1</span> in the selected window.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            items={RANGE_ITEMS}
            value={range}
            onChange={setRange}
            label="Statistics range"
            size="sm"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={reloadAll}
            loading={stats.fetching || recent.fetching}
            loadingLabel="Refreshing"
          >
            Refresh
          </Button>
        </div>
      </div>

      {stats.error ? (
        isUnauthorized(stats.error) ? null : (
          <ErrorState
            title="Statistics are unavailable"
            message={stats.error.message}
            action={
              <Button size="sm" variant="secondary" onClick={stats.refresh}>
                Try again
              </Button>
            }
          />
        )
      ) : null}

      <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.loading || !totals ? (
          <>
            <StatCardSkeleton label="Requests" />
            <StatCardSkeleton label="Error rate" />
            <StatCardSkeleton label="Avg latency" />
            <StatCardSkeleton label="Tokens" />
          </>
        ) : (
          <>
            <StatCard
              label="Requests"
              value={formatNumber(totals.requests)}
              hint={`Last ${range}`}
              icon={<Activity size={14} aria-hidden="true" />}
              tone="neutral"
            />
            <StatCard
              label="Error rate"
              value={formatPercent(totals.errorRate)}
              hint="Share of responses with status 400 or higher"
              icon={<TriangleAlert size={14} aria-hidden="true" />}
              tone={totals.errorRate > 0.05 ? 'danger' : 'brand'}
            />
            <StatCard
              label="Avg latency"
              value={formatLatency(totals.avgLatencyMs)}
              hint="Upstream round trip, averaged"
              icon={<Gauge size={14} aria-hidden="true" />}
            />
            <StatCard
              label="Tokens"
              value={formatTokens(tokenTotal)}
              title={`input ${formatNumber(totals.inputTokens)} / output ${formatNumber(totals.outputTokens)}`}
              hint={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
              icon={<Activity size={14} aria-hidden="true" />}
              tone="info"
            />
          </>
        )}
      </section>

      {stats.data ? <UsageChart stats={stats.data} /> : stats.loading ? (
        <Card>
          <LoadingBlock label="Loading usage" />
        </Card>
      ) : null}

      <Card flush className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border p-4">
          <CardTitle eyebrow="Requests" description={`The ${RECENT_LIMIT} most recent proxied requests.`}>
            Recent activity
          </CardTitle>
          <Link
            href="/console/logs"
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            View all logs
            <ArrowRight size={12} aria-hidden="true" />
          </Link>
        </div>

        {recent.loading ? (
          <LoadingBlock label="Loading recent requests" />
        ) : recent.error ? (
          isUnauthorized(recent.error) ? null : (
            <div className="p-4">
              <ErrorState
                compact
                title="Recent requests are unavailable"
                message={recent.error.message}
                action={
                  <Button size="sm" variant="secondary" onClick={recent.refresh}>
                    Try again
                  </Button>
                }
              />
            </div>
          )
        ) : recent.data && recent.data.data.length > 0 ? (
          <LogTable rows={recent.data.data} variant="compact" />
        ) : (
          <EmptyState
            compact
            title="No requests yet"
            description="Create an API key, point a client at /api/v1/messages and traffic will appear here."
            action={
              <Link
                href="/console/keys"
                className="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface-2 px-3 text-xs font-medium text-text hover:border-text-muted"
              >
                Create an API key
              </Link>
            }
          />
        )}
      </Card>
    </div>
  );
}
