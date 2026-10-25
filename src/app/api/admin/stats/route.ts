import { ok, withAdmin } from '@/lib/api-helpers';
import { computeStats, normalizeStatsRange } from '@/lib/stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C7: dashboard statistics.
 * `totals.requests` is a `COUNT(*)` over the same window as `series`, so it always
 * matches the number of `request_logs` rows in the range.
 */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => {
    const url = new URL(request.url);
    const range = normalizeStatsRange(url.searchParams.get('range'));
    return ok(computeStats(range));
  });
}
