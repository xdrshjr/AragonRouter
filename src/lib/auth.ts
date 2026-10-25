import { hmacSha256Hex, timingSafeEqualString } from '@/lib/crypto';
import { getAdminPassword, getSessionSecret, isCookieSecureEnabled } from '@/lib/env';

/** Cookie name shared by the console (C3). */
export const SESSION_COOKIE = 'aragon_session';

/** Sessions live for seven days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/**
 * Compare the submitted password with `ADMIN_PASSWORD` in constant time.
 * Never throws on a missing configuration: an unconfigured server must not accept logins.
 */
export function verifyAdminPassword(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  let expected: string;
  try {
    expected = getAdminPassword();
  } catch {
    return false;
  }
  return timingSafeEqualString(candidate, expected);
}

/**
 * Build a stateless session token: `<expiresAtMs>.<hmacHex>`.
 * The HMAC covers the expiry timestamp only, so tampering with it invalidates the token.
 */
export function createSessionToken(now: number = Date.now(), secret?: string): string {
  const signingKey = secret ?? getSessionSecret();
  const expiresAt = now + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return `${payload}.${hmacSha256Hex(signingKey, payload)}`;
}

/** Validate signature and expiry of a session token. */
export function verifySessionToken(
  token: unknown,
  now: number = Date.now(),
  secret?: string,
): boolean {
  if (typeof token !== 'string') return false;
  const separator = token.indexOf('.');
  if (separator <= 0 || separator !== token.lastIndexOf('.')) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d{1,17}$/.test(payload) || !/^[0-9a-f]{64}$/i.test(signature)) return false;

  let signingKey: string;
  try {
    signingKey = secret ?? getSessionSecret();
  } catch {
    return false;
  }
  if (!timingSafeEqualString(signature.toLowerCase(), hmacSha256Hex(signingKey, payload))) {
    return false;
  }
  const expiresAt = Number.parseInt(payload, 10);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Parse a `Cookie` request header into a plain object. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const name = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();
    if (name.length === 0) continue;
    let value = rawValue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

/** Extract the session token from `Cookie` (or `Authorization: Bearer` for scripts). */
export function getSessionTokenFromRequest(request: Request): string | null {
  const cookieToken = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

/** True when the request carries a valid admin session. */
export function isAdminRequest(request: Request, now: number = Date.now()): boolean {
  try {
    return verifySessionToken(getSessionTokenFromRequest(request), now);
  } catch {
    return false;
  }
}

/** Alias kept explicit for route handlers: throws nothing, returns a boolean. */
export function requireAdmin(request: Request): boolean {
  return isAdminRequest(request);
}

export interface SessionCookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
}

/**
 * Serialize the `Set-Cookie` value for a fresh session.
 * Matches C3: `aragon_session=<exp>.<hmacHex>; Path=/; HttpOnly; SameSite=Lax`.
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
