import { fail, ok, withAdmin } from '@/lib/api-helpers';
import { getApiKey, revokeApiKey } from '@/lib/apikeys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** C5: single key lookup (never includes the plaintext key or its hash). */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id } = await context.params;
    const key = getApiKey(id);
    if (!key) return fail('api key not found', 404);
    return ok(key);
  });
}

/** C5: soft revoke - the row is kept and `revokedAt` is stamped. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id } = await context.params;
    let revoked = false;
    try {
      revoked = revokeApiKey(id);
    } catch (error) {
      console.error('[admin] unable to revoke api key:', error);
      return fail('unable to revoke the api key', 500);
    }
    if (!revoked) return fail('api key not found', 404);
    return ok({ id });
  });
}
