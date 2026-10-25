import { fail, mapDomainError, ok, okList, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { createApiKey, listApiKeys } from '@/lib/apikeys';
import { newId } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** C5: list every key (never includes the plaintext key or its hash). */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => okList(listApiKeys()));
}

/**
 * C5: create a key. The plaintext `key` is returned exactly once, in this
 * response only - the database stores nothing but a SHA-256 hash.
 */
export async function POST(request: Request): Promise<Response> {
  return withAdmin(request, async () => {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    try {
      const created = createApiKey(parsed.body.name, newId());
      return ok({ ...created.public, key: created.key });
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
