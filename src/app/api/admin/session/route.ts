import {
  fail,
  isSecureRequest,
  ok,
  parseJsonBody,
  serverError,
  withAdmin,
  withAuth,
} from '@/lib/api-helpers';
import { serializeClearedSessionCookie, serializeSessionCookie } from '@/lib/auth';
import {
  clearFailures,
  clientFingerprint,
  isThrottled,
  recordFailure,
} from '@/lib/login-throttle';
import { createSession, describeSessionClient, revokeSession } from '@/lib/sessions';
import { authenticateUser, ensureBootstrapAdmin, validateUsername } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The account the login form signs in as when it does not name one (legacy body). */
const DEFAULT_USERNAME = 'admin';
/** Never distinguishes "no such user" from "wrong password" (no account oracle). */
const CREDENTIAL_ERROR = 'invalid password';

/**
 * Resolve the username carried by the login body.
 *
 * `{ password }` alone keeps working because the console's typed client and the
 * PowerShell scripts still post exactly that; an explicit `username` is validated at
 * the boundary and rejected there instead of being handed to the store.
 *
 * @returns the username, or `null` when the supplied value is not a valid username.
 */
function requestedUsername(body: Record<string, unknown>): string | null {
  const raw = body.username;
  if (raw === undefined || raw === null) return DEFAULT_USERNAME;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_USERNAME;
  return validateUsername(trimmed) === null ? trimmed : null;
}

/**
 * Materialise the bootstrap `admin` row on first login.
 *
 * A fresh install has no `users` row yet: its only credential is `ADMIN_PASSWORD`,
 * which is hashed into the bootstrap account here (idempotent - an existing row is
 * returned untouched). A missing `ADMIN_PASSWORD` just means there is nothing to
 * check against, which the login below reports as 401 rather than as a config error.
 */
function ensureBootstrapRow(): void {
  try {
    ensureBootstrapAdmin();
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    console.error('[auth] bootstrap admin is not available:', name);
  }
}

/**
 * C-TOKEN / C-GUARD: exchange credentials for a database session cookie.
 *
 * `Set-Cookie: aragon_session=<32hex sessionId>.<64hex secret>; Path=/; HttpOnly;
 * SameSite=Lax; Max-Age=<7 days>` - the row behind it stores only `sha256(secret)`.
 *
 * Answers: 400 for a malformed body, 401 for bad/unknown/disabled credentials, 403
 * for a valid credential that is not an active admin (this endpoint is the admin
 * door; members sign in through the account routes), 429 while throttled.
 *
 * A disabled owner never reaches the cookie: the credential check is
 * `authenticateUser`, which refuses disabled accounts, so the response cannot assert
 * a success that every other route would then reject.
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
  const username = requestedUsername(parsed.body);
  if (username === null) {
    recordFailure(fingerprint, now);
    return fail(CREDENTIAL_ERROR, 401);
  }

  if (username.toLowerCase() === DEFAULT_USERNAME) ensureBootstrapRow();

  const user = authenticateUser(username, password, now);
  if (!user) {
    recordFailure(fingerprint, now);
    return fail(CREDENTIAL_ERROR, 401);
  }
  if (user.role !== 'admin') {
    // Valid member credentials, wrong door: say so instead of pretending the password
    // was wrong, and do not count it as a failed attempt.
    clearFailures(fingerprint);
    return fail('forbidden', 403);
  }

  clearFailures(fingerprint);
  try {
    const client = describeSessionClient(request);
    const session = createSession(user.id, {
      now,
      userAgent: client.userAgent,
      ip: client.ip,
    });
    return ok({ ok: true }, 200, {
      'set-cookie': serializeSessionCookie(session.token, { secure: isSecureRequest(request) }),
    });
  } catch (error) {
    // No token, no password and no hash in the log line: only the failure class.
    const reason = error instanceof Error ? error.name : 'unknown';
    console.error('[auth] unable to create a session:', reason);
    return serverError('unable to create a session');
  }
}

/** Session probe for the console: 200 only when the cookie is a live admin session. */
export async function GET(request: Request): Promise<Response> {
  return withAdmin(request, () => ok({ ok: true }));
}

/**
 * C-SESSION-STORE: log out.
 *
 * Revoking the *row* is the point: clearing the cookie only tells this browser to
 * forget a credential that would keep working for the rest of its seven-day TTL
 * (and that a copy of the cookie jar would keep using).
 *
 * `withAuth`, not `withAdmin`: ending your own session is never a privileged
 * operation, so a member's console signs out through the same call. There is no
 * privilege to escalate here - the handler can only touch the caller's own row.
 */
export async function DELETE(request: Request): Promise<Response> {
  return withAuth(request, (_request, context) => {
    revokeSession(context.session.id);
    return ok({ ok: true }, 200, {
      'set-cookie': serializeClearedSessionCookie(isSecureRequest(request)),
    });
  });
}
