import { fail, ok, withAdmin } from '@/lib/api-helpers';
import { getSessionById, revokeSession } from '@/lib/sessions';
import { getUserById } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>;
}

/**
 * C-USERS-WIRE: revoke one device session of one account.
 *
 * Idempotent: revoking an already-revoked session answers `{data:{ok:true}}` again
 * (the row still exists, and the second call cannot un-revoke anything).
 *
 * A session that belongs to a different user is reported exactly like a session
 * that does not exist (404 `session not found`), and an unknown user as a 404
 * `user not found`: the endpoint never confirms the existence of anything beyond
 * the two ids in its own path.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async () => {
    const { id, sessionId } = await context.params;
    if (!getUserById(id)) return fail('user not found', 404);
    const session = getSessionById(sessionId);
    if (!session || String(session.user_id) !== String(id)) {
      return fail('session not found', 404);
    }
    // Re-check the write: the row can be deleted between the lookup and here.
    if (!revokeSession(sessionId, Date.now())) return fail('session not found', 404);
    return ok({ ok: true });
  });
}
