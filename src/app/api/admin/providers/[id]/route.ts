import { fail, mapDomainError, ok, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { deleteProvider, getProvider, updateProvider } from '@/lib/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** C6: single provider (masked key only). */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id } = await context.params;
    const provider = getProvider(id);
    if (!provider) return fail('provider not found', 404);
    return ok(provider);
  });
}

/** C6: partial update. Omit `apiKey` to keep the stored credential untouched. */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id } = await context.params;
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    try {
      const provider = updateProvider(id, {
        name: parsed.body.name,
        protocol: parsed.body.protocol,
        baseUrl: parsed.body.baseUrl,
        apiKey: parsed.body.apiKey,
        enabled: parsed.body.enabled,
      });
      if (!provider) return fail('provider not found', 404);
      return ok(provider);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}

/** C6: delete a provider. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id } = await context.params;
    let removed = false;
    try {
      removed = deleteProvider(id);
    } catch (error) {
      console.error('[admin] unable to delete provider:', error);
      return fail('unable to delete the provider', 500);
    }
    if (!removed) return fail('provider not found', 404);
    return ok({ id });
  });
}
