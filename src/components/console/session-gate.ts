/**
 * Session helpers shared by the guest shell and the `/login` fallback.
 *
 * The console is **guest first**: `/console/**` renders its shell for everybody and
 * replaces the panel area with a sign-in mask, so nothing here redirects any more
 * (the previous `requireSession` hard gate was retired with that decision).
 *
 * What remains is deliberately pure - no `next/headers`, no `next/navigation` - so
 * the same module can be imported by a server component (the login page inspects
 * the cookie to explain "your session expired") and by the client mask that links
 * to the full-page fallback.
 *
 * The cookie value is never logged, echoed or forwarded, and its shape is only an
 * *advisory* signal: `GET /api/auth/session` remains the single authority.
 */

/** The login route: the deep-link fallback, no longer a mandatory gate. */
export const LOGIN_ROUTE = '/login';

/** C-SCHEMA cookie name. */
export const SESSION_COOKIE = 'aragon_session';

/**
 * C-TOKEN token shape: `<32 hex sessionId>.<64 hex secret>`.
 *
 * This is the exact shape the kernel mints, so a value that passes is at least the
 * right kind of credential - it is not a validity proof. The retired
 * `<expiresAtMs>.<hmacHex>` form must stay rejected, or this helper and the API
 * would disagree about what a session even looks like.
 */
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{32}\.[0-9a-f]{64}$/i;

/** True when the cookie value is shaped like a session token (not a validity proof). */
export function hasSessionCookieShape(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  return SESSION_TOKEN_PATTERN.test(value.trim());
}

/**
 * Build the `/login?next=` deep link for a console path.
 *
 * Only a same-origin absolute path is forwarded, so this can never become an open
 * redirect; `/login` itself is not a valid target.
 */
export function buildLoginHref(nextPath: string | null | undefined): string {
  if (typeof nextPath !== 'string' || !nextPath.startsWith('/') || nextPath.startsWith('//')) {
    return LOGIN_ROUTE;
  }
  if (nextPath.includes('\\')) return LOGIN_ROUTE;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(nextPath)) return LOGIN_ROUTE;
  if (nextPath === LOGIN_ROUTE || nextPath.startsWith(`${LOGIN_ROUTE}?`)) return LOGIN_ROUTE;
  return `${LOGIN_ROUTE}?next=${encodeURIComponent(nextPath)}`;
}
