/**
 * Server-side session gate for the console pages (C3).
 *
 * What this can and cannot do without leaving the console work package: the HMAC
 * secret (`SESSION_SECRET`) lives in `src/lib`, which the UI layer must not import,
 * so the edge of the UI can only verify that a C3-shaped session cookie is
 * present. That check is **advisory**:
 *
 *   - it keeps a browser with no session at all (or with JavaScript disabled) out
 *     of `/console`, so "unauthenticated /console returns to the login page" holds
 *     even before any script runs;
 *   - the authoritative check stays in the API: every `/api/admin/**` response is
 *     proven server-side by `withAdmin`, `AuthGuard` verifies the cookie through
 *     `GET /api/admin/session`, and every page re-checks on its first data fetch,
 *     so a forged or expired cookie fails there and the UI redirects to `/login`.
 *
 * The cookie value is never logged, echoed or forwarded.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/** C3 cookie name; declared locally so this server module imports no client code. */
const SESSION_COOKIE = 'aragon_session';

/** C3 token shape: `<expiresAtMs>.<64 hex>`. */
const SESSION_TOKEN_PATTERN = /^\d{1,17}\.[0-9a-f]{64}$/i;

export const LOGIN_ROUTE = '/login';

/** True when the cookie value is shaped like a session token (not a validity proof). */
export function hasSessionCookieShape(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  return SESSION_TOKEN_PATTERN.test(value.trim());
}

/**
 * Build the login redirect target for a console path.
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

/**
 * Redirect to the login page when the session cookie is missing or malformed.
 * Returns normally when a session is plausibly present; `AuthGuard` then proves it
 * against `GET /api/admin/session`.
 */
export async function requireSession(nextPath: string): Promise<void> {
  let token: string | undefined;
  try {
    const store = await cookies();
    token = store.get(SESSION_COOKIE)?.value;
  } catch {
    // `cookies()` is unavailable when a page is statically rendered; treat it as
    // "no session" and let the redirect run.
    token = undefined;
  }
  if (hasSessionCookieShape(token)) return;
  redirect(buildLoginHref(nextPath));
}
