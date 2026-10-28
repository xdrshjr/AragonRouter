import {
  fail,
  mapDomainError,
  ok,
  parseJsonBody,
  serverError,
  withAuth,
} from '@/lib/api-helpers';
import { clearFailures, clientFingerprint, isThrottled, recordFailure } from '@/lib/login-throttle';
import { authenticateUser, setUserPassword } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C-AUTH-WIRE: `POST /api/auth/password`
 *
 * `{currentPassword,newPassword}` -> `200 {data:{ok:true}}`, authenticated by the
 * session cookie (`withAuth`, so a guest gets the standard 401 `unauthorized`).
 *
 * Two guarantees the console relies on:
 *  - **the current password is re-verified.** A live cookie alone is not consent to
 *    change the credential: an attacker holding a borrowed session must not be able to
 *    take the account over with it.
 *  - **every other session of the account is revoked** (see `setUserPassword`, which
 *    takes `exceptSessionId`). This device stays signed in; any other device the old
 *    password was used on is signed out, which is the whole point of a password change
 *    after a compromise.
 *
 * A wrong `currentPassword` answers **400, not 401**: 401 is the console's global
 * "your session is gone" signal and would bounce the user to the login page even
 * though their session is perfectly fine - the mistyped value is a form field.
 */

/** Two short secrets: 8 KiB is already far beyond any legitimate request. */
const AUTH_BODY_MAX_BYTES = 8 * 1024;
/** Mirrors `validatePasswordStrength`; the policy itself is enforced by the store. */
const PASSWORD_MAX_LENGTH = 200;

const THROTTLED_MESSAGE = 'too many failed attempts, try again in a minute';
const CURRENT_PASSWORD_ERROR = 'current password is incorrect';

/** A password is never trimmed: whitespace is part of the secret. */
function readSecret(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > maxLength) return null;
  return raw;
}

/** Log a failure class without ever echoing a password or a cookie. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, async (authenticatedRequest, context) => {
    const now = Date.now();
    const fingerprint = clientFingerprint(authenticatedRequest);
    // Guessing the *current* password is the same attack the login throttle exists
    // for, so a saturated fingerprint is refused here too (shared counter).
    if (isThrottled(fingerprint, now)) return fail(THROTTLED_MESSAGE, 429);

    const parsed = await parseJsonBody(authenticatedRequest, AUTH_BODY_MAX_BYTES);
    if (!parsed.ok) return fail(parsed.message, parsed.status);

    const currentPassword = readSecret(parsed.body.currentPassword, PASSWORD_MAX_LENGTH);
    if (!currentPassword) return fail('currentPassword is required', 400);
    const newPassword = readSecret(parsed.body.newPassword, PASSWORD_MAX_LENGTH);
    if (!newPassword) return fail('newPassword is required', 400);

    // `authenticateUser` is the single credential path (constant-time scrypt, refuses
    // disabled accounts). It also refreshes `last_login_at`, which is why this is the
    // preferred entry point over a second, hand-rolled hash comparison.
    if (!authenticateUser(context.user.username, currentPassword, now)) {
      recordFailure(fingerprint, now);
      return fail(CURRENT_PASSWORD_ERROR, 400);
    }

    try {
      // `exceptSessionId` keeps this device signed in while every other session dies.
      setUserPassword(context.user.id, newPassword, now, context.session.id);
      clearFailures(fingerprint);
      return ok({ ok: true });
    } catch (error) {
      const mapped = mapDomainError(error);
      if (mapped) return mapped;
      console.error('[auth] unable to change the password:', describeFailure(error));
      return serverError('unable to change the password');
    }
  });
}
