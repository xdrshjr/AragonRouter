import { fail, okList, withAdmin } from '@/lib/api-helpers';
import { listRequestLogs, parseCursor } from '@/lib/logs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C8: paginated request log.
 * Query: `limit` (default 50, max 200), `cursor=<created_at>|<id>`,
 * `status`, `model` (plus optional `protocol`, `path`, `apiKeyId`).
 */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => {
    const url = new URL(request.url);
    const cursorParam = url.searchParams.get('cursor');
    if (cursorParam && !parseCursor(cursorParam)) {
      return fail('cursor must have the form <created_at>|<id>', 400);
    }
    const result = listRequestLogs({
      limit: url.searchParams.get('limit'),
      cursor: cursorParam,
      status: url.searchParams.get('status'),
      model: url.searchParams.get('model'),
      protocol: url.searchParams.get('protocol'),
      path: url.searchParams.get('path'),
      apiKeyId: url.searchParams.get('apiKeyId'),
    });
    return okList(result.data, result.nextCursor);
  });
}
