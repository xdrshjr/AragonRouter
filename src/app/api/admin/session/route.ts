import { fail, isSecureRequest, ok, parseJsonBody, withAdmin } from '@/lib/api-helpers';
import {
  createSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  verifyAdminPassword,
} from '@/lib/auth';
import {
  clearFailures,
  clientFingerprint,
  isThrottled,
  recordFailure,
} from '@/lib/login-throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C3: exchange the admin password for a signed session cookie.
 * `Set-Cookie: aragon_session=<exp>.<hmacHex>; Path=/; HttpOnly; SameSite=Lax`
 */
export async function POST(request: Request): Promise<Response> {
  const now = Date.now();
  const fingerprint = clientFingerprint(request);
  if (isThrottled(fingerprint, now)) {
    return fail('too many failed login attempts, try again in a minute', 429);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return fail(parsed.message, parsed.status);

  const password = parsed.body.password;
  if (typeof password !== 'string' || password.length === 0) {
    return fail('password is required', 400);
  }
  if (!verifyAdminPassword(password)) {
    recordFailure(fingerprint, now);
    return fail('invalid password', 401);
  }

  clearFailures(fingerprint);
  const token = createSessionToken(now);
  return ok({ ok: true }, 200, {
    'set-cookie': serializeSessionCookie(token, { secure: isSecureRequest(request) }),
  });
}

/** Session probe for the console: 200 only when the cookie is valid. */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => ok({ ok: true }));
}

/** C3: log out. Clears the cookie; requires a session like every /api/admin route. */
export async function DELETE(request: Request): Promise<Response> {
  return withAdmin(request, () =>
    ok({ ok: true }, 200, {
      'set-cookie': serializeClearedSessionCookie(isSecureRequest(request)),
    }),
  );
}
