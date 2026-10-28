import { fail, mapDomainError, ok, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import { listUserSessions } from '@/lib/sessions';
import { deleteUser, getUserById, updateUser } from '@/lib/users';
import type { UserDetailPublic } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const USER_NOT_FOUND = 'user not found';

/**
 * Type gate for the two enum fields of a PATCH. `undefined` means "not sent", so it
 * stays a no-op; anything that is not a string is the caller's mistake.
 *
 * `updateUser` reads `null` as "use the default", which on a *partial* update would
 * turn `{"status":null}` into "re-activate this disabled account" and `{"role":null}`
 * into "demote this admin" - a silent rewrite of a field nobody asked to change.
 * C-USERS-WIRE documents that leg as a 400, so it is refused here.
 */
function readEnumField(
  value: unknown,
  message: string,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, message };
  return { ok: true, value };
}

/**
 * Detail DTO: the public user plus the devices that are signed in right now.
 *
 * `currentSessionId` is the caller's own session so the console can label the row
 * the administrator is holding; every other session is `current: false`.
 */
function readDetail(userId: string, currentSessionId: string): UserDetailPublic | null {
  const user = getUserById(userId);
  if (!user) return null;
  return { ...user, sessions: listUserSessions(user.id, { currentSessionId }) };
}

/** C-USERS-WIRE: one account with its live sessions. Unknown id => 404. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async (_request, actor) => {
    const { id } = await context.params;
    const detail = readDetail(id, actor.session.id);
    if (!detail) return fail(USER_NOT_FOUND, 404);
    return ok(detail);
  });
}

/**
 * C-USERS-WIRE: partial update of `displayName` / `role` / `status`.
 *
 * `actor.user.id` is the whole point of the guard handing over the actor: it is
 * what lets the store refuse "disable yourself", "demote yourself" and "remove the
 * last active admin" (all 400 with a message the console can show verbatim).
 * Unknown request fields are ignored - the username is deliberately not editable
 * here, and only the three documented fields are read.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async (_request, actor) => {
    const { id } = await context.params;
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return fail(parsed.message, parsed.status);
    const role = readEnumField(parsed.body.role, "role must be 'admin' or 'member'");
    if (!role.ok) return fail(role.message, 400);
    const status = readEnumField(parsed.body.status, "status must be 'active' or 'disabled'");
    if (!status.ok) return fail(status.message, 400);
    try {
      const updated = updateUser(
        id,
        {
          displayName: parsed.body.displayName,
          role: role.value,
          status: status.value,
        },
        Date.now(),
        { actorId: actor.user.id },
      );
      return ok(updated);
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}

/**
 * C-USERS-WIRE: delete an account (its sessions cascade).
 *
 * `{data:{ok:true}}` on success. Deleting yourself or the last active admin is a
 * 400 rule violation, and an unknown id is a 404 - the response never says more
 * than "this id does or does not exist".
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return withAdmin(request, async (_request, actor) => {
    const { id } = await context.params;
    try {
      const removed = deleteUser(id, Date.now(), { actorId: actor.user.id });
      if (!removed) return fail(USER_NOT_FOUND, 404);
      return ok({ ok: true });
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
