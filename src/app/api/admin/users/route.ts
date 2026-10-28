import { fail, mapDomainError, ok, okList, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { createUser, listUsers } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Query parameters of `GET /api/admin/users` (C-USERS-WIRE).
 *
 * A request whose URL cannot be parsed simply has no filters: the guard already
 * ran, and the unfiltered first page is a truthful answer for "no filter given".
 */
function readQuery(request: Request): URLSearchParams {
  try {
    return new URL(request.url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * C-USERS-WIRE: keyset-paginated user list.
 *
 * `{data, nextCursor}` is returned verbatim from `listUsers`, which already clamps
 * `limit` to `MAX_USER_LIMIT` (100), escapes the `search` term and rejects an
 * unknown `role`/`status` with `UserValidationError` - mapped to 400 below so the
 * console never renders a page that silently is not the one that was asked for.
 */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => {
    const params = readQuery(request);
    try {
      const page = listUsers({
        limit: params.get('limit'),
        cursor: params.get('cursor'),
        search: params.get('search'),
        role: params.get('role'),
        status: params.get('status'),
      });
      // `nextCursor` is part of the contract, so it is sent even when it is null.
      return okList(page.data, page.nextCursor);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}

/**
 * C-USERS-WIRE: create an account.
 *
 * Answers 201 with the `UserPublic` DTO. A duplicate username, a weak password, a
 * malformed username or an unknown role are all 400 and leave the table untouched
 * (validation happens before the INSERT inside `createUser`).
 */
export async function POST(request: Request): Promise<Response> {
  return withAdmin(request, async () => {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    try {
      const created = createUser({
        username: parsed.body.username,
        password: parsed.body.password,
        role: parsed.body.role,
        displayName: parsed.body.displayName,
      });
      return ok(created, 201);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
