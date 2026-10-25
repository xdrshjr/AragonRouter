import { authorizeClientRequest, clientError, parseJsonBody } from '@/lib/api-helpers';
import { relay } from '@/lib/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Anthropic-compatible entry point (C2 / C9).
 * Authenticated with `x-api-key: ar-...`, proxied to `{baseUrl}/v1/messages`.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authorizeClientRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) {
    return clientError(
      parsed.message,
      parsed.status,
      parsed.status === 413 ? 'request_too_large' : 'invalid_request_error',
    );
  }

  try {
    const result = await relay({
      protocol: 'anthropic',
      request,
      body: parsed.body,
      apiKeyId: auth.apiKey.id,
    });
    return result.response;
  } catch (error) {
    console.error('[relay] anthropic relay failed:', error);
    return clientError('upstream relay failed', 502, 'api_error');
  }
}
