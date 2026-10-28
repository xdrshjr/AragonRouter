import { ok } from '@/lib/api-helpers';
import { isSecureRequest, serializeClearedSessionCookie } from '@/lib/auth';
import { authenticateRequest, revokeSession } from '@/lib/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C-AUTH-WIRE: `POST /api/auth/logout` -> `200 {data:{ok:true}}` + cleared cookie.
 *
 * Two halves, and the row is the half that matters:
 *  - `revokeSession` marks the `user_sessions` row dead, so a copied cookie jar, a
 *    second tab or an attacker holding the same value loses access immediately;
 *  - the `Max-Age=0` `Set-Cookie` only tells *this* browser to forget the value.
 * Clearing the cookie alone would leave the credential valid for the rest of its
 * seven-day TTL, which is not a logout.
 *
 * A guest (no cookie, or a dead/foreign cookie) also gets `200 {data:{ok:true}}`:
 * "make sure I am signed out" is idempotent, and 401 would make the console treat a
 * deliberate sign-out as an expired session.
 *
 * The revocation failure is logged and swallowed on purpose - the cookie is cleared in
 * every branch, and answering 500 would hand the browser a credential it was just told
 * to drop. The stale row expires on its own and can be revoked by an admin.
 */
export async function POST(request: Request): Promise<Response> {
  const cleared = serializeClearedSessionCookie(isSecureRequest(request));
  try {
    const context = authenticateRequest(request);
    if (context) revokeSession(context.session.id);
  } catch (error) {
    // Failure class only: no token, no secret, no cookie value in the log.
    const reason = error instanceof Error ? error.name : 'unknown';
    console.error('[auth] unable to revoke the session row:', reason);
  }
  return ok({ ok: true }, 200, { 'set-cookie': cleared });
}
