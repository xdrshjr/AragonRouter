import { ok, serverError } from '@/lib/api-helpers';
import { authenticateRequest } from '@/lib/sessions';
import { getRegistrationSetting } from '@/lib/settings';
import type { RegistrationSetting, UserPublic } from '@/lib/types';
import { getUserById } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C-AUTH-WIRE: `GET /api/auth/session`
 *
 * `200 {data:{user:UserPublic|null, registration:{enabled:boolean}}}`.
 *
 * A guest is a **normal** state, not an error: the console shell renders for everyone
 * and only the panel data area is replaced by a sign-in mask, so this endpoint must
 * answer 200 with `user:null` rather than 401. Its consumer is the whole console; a
 * 401 here would make every visitor look like an expired session and bounce them to
 * `/login`, which is exactly the behaviour the product decision retired.
 *
 * `user` is the full `UserPublic` (not the trimmed `AuthContext['user']`) because the
 * top bar renders the display name and the role. The DTO has no field for a password
 * hash, so nothing sensitive can leak through this shape.
 *
 * `registration.enabled` travels with the session on purpose: the login/register modal
 * needs it before the visitor has signed in, and it must not require the admin-only
 * `/api/admin/settings`.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const registration: RegistrationSetting = getRegistrationSetting();
    return ok({ user: resolveCurrentUser(request), registration });
  } catch (error) {
    // A database/configuration fault is a real 500: answering 200 with `user:null`
    // would tell the console "signed out" for a session that is merely unreadable.
    // Only the failure class is logged - never the cookie, never the token.
    const reason = error instanceof Error ? error.name : 'unknown';
    console.error('[auth] unable to read the session state:', reason);
    return serverError('unable to read the session');
  }
}

/**
 * The signed-in account, or `null` for a guest.
 *
 * Every "not that" case - absent cookie, malformed token, unknown/expired/revoked
 * session row, disabled account - is already `null` from `authenticateRequest`, and
 * none of them may surface as an error. The remaining `null` case is a session whose
 * user row disappeared between the two reads (an admin deleting the account while the
 * cookie is in flight), which is a guest as well.
 */
function resolveCurrentUser(request: Request): UserPublic | null {
  const context = authenticateRequest(request);
  if (!context) return null;
  return getUserById(context.user.id);
}
