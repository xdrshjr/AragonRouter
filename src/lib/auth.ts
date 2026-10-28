import { getAdminPassword, isCookieSecureEnabled } from '@/lib/env';
import { timingSafeEqualString } from '@/lib/crypto';
import { queryOne } from '@/lib/db';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  authenticateRequest,
  authenticateSessionToken,
  createSession,
  revokeSession,
  type CreatedSession,
} from '@/lib/sessions';
import { ensureBootstrapAdmin } from '@/lib/users';
import { verifyPassword } from '@/lib/password';
import type { AuthContext } from '@/lib/types';

/**
 * Authentication surface (C-TOKEN, C-GUARD).
 *
 * The implementation moved from stateless HMAC cookies to database sessions, but
 * **every export name and signature below is unchanged** so that the existing
 * route handlers, the PowerShell scripts and the legacy test suite keep working:
 *
 *  - `serializeSessionCookie` / `serializeClearedSessionCookie` / `parseCookies` /
 *    `getSessionTokenFromRequest` / `isSecureRequest` - cookie plumbing;
 *  - `verifyAdminPassword` - the `admin` row's stored hash, falling back to
 *    `ADMIN_PASSWORD` only while that row does not exist yet;
 *  - `createSessionToken` / `verifySessionToken` - session mint/probe;
 *  - `isAdminRequest` / `requireAdmin` - the boolean guards.
 */

export { SESSION_COOKIE, SESSION_TTL_MS, SESSION_TTL_SECONDS };
export { parseCookies, getSessionTokenFromRequest } from '@/lib/sessions';

/**
 * Compare the submitted password with the stored credential of the bootstrap
 * `admin` account.
 *
 * The row is authoritative as soon as it exists: rotating `ADMIN_PASSWORD` in the
 * environment or resetting the password through the account store must actually
 * retire the previous credential, otherwise a leaked password would survive every
 * documented remediation. `ADMIN_PASSWORD` is therefore only consulted while no
 * `admin` row exists yet (first boot, before the credential has been hashed).
 *
 * The account **status** is part of the credential check: a disabled `admin` row
 * refuses every candidate, so no caller of this legacy helper can mint a session for
 * an account that an operator has switched off.
 *
 * Never throws: an unconfigured or unreachable server must not accept logins.
 */
export function verifyAdminPassword(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;

  let storedHash: string | null = null;
  let adminStatus: string | null = null;
  let hasAdminRow = false;
  try {
    const row = queryOne<{ password_hash: string; status: string }>(
      'SELECT password_hash, status FROM users WHERE username_lower = ?',
      ['admin'],
    );
    if (row) {
      hasAdminRow = true;
      storedHash = String(row.password_hash);
      adminStatus = String(row.status);
    }
  } catch {
    // Unreachable database (missing node:sqlite, no schema yet): no row is known,
    // so the environment credential - the only one that can exist then - decides.
    hasAdminRow = false;
  }

  if (hasAdminRow) {
    if (adminStatus !== 'active') return false;
    return verifyPassword(candidate, storedHash);
  }

  try {
    return timingSafeEqualString(candidate, getAdminPassword());
  } catch {
    return false;
  }
}

/**
 * Mint a session for the bootstrap admin and return the cookie value.
 *
 * Kept as a compatibility shell for the test fixtures and the console gate:
 * the returned token has the C-TOKEN shape `<32hex sessionId>.<64hex secret>`
 * and is a real database session.
 *
 * The `secret` parameter is accepted (legacy signature) but ignored - sessions
 * are no longer signed with `SESSION_SECRET`, they are rows. A session minted for an
 * account an operator has since disabled is inert: `authenticateRequest` refuses it
 * (see `authenticateSessionToken`), so this helper cannot bypass a disable.
 *
 * @throws ConfigurationError when neither `ADMIN_PASSWORD` nor a bootstrap admin
 *   row exists: an unconfigured server must not hand out sessions.
 */
export function createSessionToken(now: number = Date.now(), secret?: string): string {
  void secret;
  const admin = ensureBootstrapAdmin(now);
  const session: CreatedSession = createSession(admin.id, { now });
  return session.token;
}

/**
 * Validate a session token without a `Request`.
 *
 * @returns `true` when the token is a live database session (not expired, not
 *   revoked, owner active). Role checks belong to {@link isAdminRequest}.
 */
export function verifySessionToken(
  token: unknown,
  now: number = Date.now(),
  secret?: string,
): boolean {
  void secret;
  try {
    return authenticateSessionToken(token, now) !== null;
  } catch {
    return false;
  }
}

/**
 * Resolve the request to its actor.
 * @returns `null` for an absent, malformed, expired or revoked session, or a
 *   disabled user.
 */
export function getAuthContext(request: Request, now: number = Date.now()): AuthContext | null {
  try {
    return authenticateRequest(request, now);
  } catch {
    return null;
  }
}

/** True when the request carries a live session whose user is an active admin. */
export function isAdminRequest(request: Request, now: number = Date.now()): boolean {
  const context = getAuthContext(request, now);
  return context !== null && context.user.role === 'admin' && context.user.status === 'active';
}

/** Alias kept explicit for route handlers: throws nothing, returns a boolean. */
export function requireAdmin(request: Request): boolean {
  return isAdminRequest(request);
}

/**
 * The actively authenticated actor, or `null`.
 *
 * Route helpers use this instead of `isAdminRequest` once they need the user id
 * (user management, "log out other devices", self-service password change).
 */
export function requireSession(request: Request): AuthContext | null {
  return getAuthContext(request);
}

/** Revoke the session carried by a request (logout). Returns false when absent. */
export function endSession(request: Request, now: number = Date.now()): boolean {
  const context = getAuthContext(request, now);
  if (!context) return false;
  return revokeSession(context.session.id, now);
}

export interface SessionCookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
}

/**
 * Serialize the `Set-Cookie` value for a fresh session (C-TOKEN):
 * `aragon_session=<sessionId>.<secret>; Path=/; HttpOnly; SameSite=Lax; Max-Age=...`.
 */
export function serializeSessionCookie(
  token: string,
  options: SessionCookieOptions = {},
): string {
  const maxAge = options.maxAgeSeconds ?? SESSION_TTL_SECONDS;
  const secure = options.secure ?? isCookieSecureEnabled();
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Serialize the `Set-Cookie` value that removes the session. */
export function serializeClearedSessionCookie(secure = isCookieSecureEnabled()): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Best-effort detection of HTTPS so that `Secure` is only set when it can work. */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Password-hash verification for the account routes (never logs the input). */
export function verifyUserPassword(password: unknown, storedHash: unknown): boolean {
  return verifyPassword(password, storedHash);
}
