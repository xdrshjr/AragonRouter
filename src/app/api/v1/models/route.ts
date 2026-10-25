import { authorizeClientRequest } from '@/lib/api-helpers';
import { getProviderTestTimeoutMs } from '@/lib/env';
import { listEnabledProviders, type RelayProvider } from '@/lib/providers';
import { MODELS_PATH, joinUpstreamUrl, upstreamAuthHeaders } from '@/lib/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ModelEntry {
  id: string;
  object: 'model';
  owned_by: string;
  provider: string;
}

async function modelsForProvider(provider: RelayProvider): Promise<ModelEntry[]> {
  try {
    const response = await fetch(joinUpstreamUrl(provider.baseUrl, MODELS_PATH), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...upstreamAuthHeaders(provider.protocol, provider.apiKey),
      },
      signal: AbortSignal.timeout(getProviderTestTimeoutMs()),
      cache: 'no-store',
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload?.data)) return [];
    const entries: ModelEntry[] = [];
    for (const item of payload.data) {
      const id =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
            ? (item as { id: string }).id
            : null;
      if (!id) continue;
      entries.push({ id, object: 'model', owned_by: provider.name, provider: provider.protocol });
    }
    return entries;
  } catch {
    // An unreachable provider must not fail the whole listing.
    return [];
  }
}

/**
 * Aggregated model catalogue for clients: every enabled provider is asked for
 * `{baseUrl}/v1/models` and the answers are merged (OpenAI list shape).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authorizeClientRequest(request);
  if (!auth.ok) return auth.response;

  let providers: RelayProvider[] = [];
  try {
    providers = listEnabledProviders();
  } catch (error) {
    console.error('[models] unable to load providers:', error);
    providers = [];
  }

  const settled = await Promise.all(providers.map((provider) => modelsForProvider(provider)));
  const seen = new Set<string>();
  const data: ModelEntry[] = [];
  for (const entry of settled.flat()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    data.push(entry);
  }

  return new Response(JSON.stringify({ object: 'list', data }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
