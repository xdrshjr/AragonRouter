import { fail, mapDomainError, ok, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { setUserPassword } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * C-USERS-WIRE: administrator password reset.
 *
 * `setUserPassword` re-hashes with the store's policy and revokes every session of
 * the target, so a stolen cookie stops working the moment the credential changes.
 *
 * `actor.session.id` is passed as the one session to keep: when an administrator
 * resets *their own* password the device they are typing on stays signed in (the
 * "change my password" flow), and when the target is somebody else the exception
 * matches no row of that user and therefore changes nothing.
 *
 * Answers `{data:{ok:true}}`; a weak password is 400, an unknown id 404.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async (_request, actor) => {
    const { id } = await context.params;
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    try {
      setUserPassword(id, parsed.body.password, Date.now(), actor.session.id);
      return ok({ ok: true });
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
