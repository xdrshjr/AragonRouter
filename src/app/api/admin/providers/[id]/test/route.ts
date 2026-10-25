import { fail, mapDomainError, ok, withAdmin } from '@/lib/api-helpers';
import { getRelayProvider, testProviderConnection } from '@/lib/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * C6: connectivity probe. Calls `GET {baseUrl}/v1/models` with the stored
 * credential under a 5 second budget and reports `{ok, message}`.
 * Never throws and never echoes the upstream key.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id } = await context.params;
    try {
      const provider = getRelayProvider(id);
      if (!provider) return fail('provider not found', 404);
      const result = await testProviderConnection(provider);
      return ok(result);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      console.error('[admin] provider test failed:', error);
      return ok({ ok: false, message: 'provider test failed unexpectedly' });
    }
  });
}
