import { fail, mapDomainError, ok, okList, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { createProvider, listProviders } from '@/lib/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** C6: list providers. `maskedKey` is always a redacted rendering. */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => okList(listProviders()));
}

/** C6: create a provider; the upstream key is encrypted with AES-256-GCM at rest. */
export async function POST(request: Request): Promise<Response> {
  return withAdmin(request, async () => {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    try {
      const provider = createProvider({
        name: parsed.body.name,
        protocol: parsed.body.protocol,
        baseUrl: parsed.body.baseUrl,
        apiKey: parsed.body.apiKey,
        enabled: parsed.body.enabled,
      });
      return ok(provider);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
