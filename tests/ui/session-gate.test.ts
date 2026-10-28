/**
 * Session helpers of the guest-first console.
 *
 * The old `requireSession` server gate is retired: `/console/**` renders its shell
 * for anybody and asks for an account only when panel data is needed, so nothing
 * may redirect a visitor away from the console. What survives is the *advice* the
 * shell and the `/login` fallback still need:
 *
 *  - {@link hasSessionCookieShape} - is this cookie at least a C-TOKEN credential?
 *    (The `/login` page uses it to tell "your session expired" apart from "you were
 *    never signed in"; it is never a validity proof.)
 *  - {@link buildLoginHref} - the safe `/login?next=` deep link, which must never
 *    become an open redirect.
 *
 * That the cookie this module accepts is the one the kernel really mints is pinned
 * end-to-end in `boundary.test.ts` (the shape is checked against a real login).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LOGIN_ROUTE,
  SESSION_COOKIE,
  buildLoginHref,
  hasSessionCookieShape,
} from '@/components/console/session-gate';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/** A token shaped exactly like the one the kernel mints (C-TOKEN): `<32 hex>.<64 hex>`. */
const VALID_SHAPED_TOKEN = `${'0123456789abcdef'.repeat(2)}.${'a1b2c3d4'.repeat(8)}`;
/** The retired stateless form `<expiresAtMs>.<hmacHex>`: shape-valid *then*, rejected now. */
const LEGACY_SHAPED_TOKEN = `${Date.now() + 86_400_000}.${'a1b2c3d4'.repeat(8)}`;

describe('hasSessionCookieShape', () => {
  it('accepts a C-TOKEN token and rejects everything else', () => {
    expect(hasSessionCookieShape(VALID_SHAPED_TOKEN)).toBe(true);
    expect(hasSessionCookieShape(` ${VALID_SHAPED_TOKEN} `)).toBe(true);
    expect(hasSessionCookieShape(undefined)).toBe(false);
    expect(hasSessionCookieShape(null)).toBe(false);
    expect(hasSessionCookieShape('')).toBe(false);
    expect(hasSessionCookieShape('abc')).toBe(false);
    expect(hasSessionCookieShape('12345.short')).toBe(false);
    expect(hasSessionCookieShape(`12345.${'z'.repeat(64)}`)).toBe(false);
    expect(hasSessionCookieShape(`${'a1b2c3d4'.repeat(8)}`)).toBe(false);
  });

  /**
   * Regression (C-TOKEN consumer drift): the gate used to match the retired
   * `<expiresAtMs>.<hmacHex>` form, so a browser carrying the current cookie was
   * treated as anonymous while the API accepted the very same value.
   */
  it('matches what the kernel mints and refuses the retired HMAC form', () => {
    expect(hasSessionCookieShape(VALID_SHAPED_TOKEN)).toBe(true);
    expect(hasSessionCookieShape(LEGACY_SHAPED_TOKEN)).toBe(false);
  });

  it('is only advisory: the API stays the authority', () => {
    // A forged but well-shaped value passes here and is refused by the server; the
    // shell therefore renders the guest mask on the server's answer, never on this.
    expect(hasSessionCookieShape('f'.repeat(32) + '.' + 'a'.repeat(64))).toBe(true);
  });
});

describe('buildLoginHref', () => {
  it('forwards a same-origin console path as ?next=', () => {
    expect(buildLoginHref('/console/keys')).toBe('/login?next=%2Fconsole%2Fkeys');
  });

  it('never becomes an open redirect', () => {
    for (const hostile of [
      '//evil.example/console',
      'https://evil.example',
      'javascript:alert(1)',
      '/console\\..\\evil',
      '/console\nHeader: x',
      '',
      'console',
    ]) {
      expect(buildLoginHref(hostile)).toBe(LOGIN_ROUTE);
    }
  });

  it('never redirects back to the login page itself', () => {
    expect(buildLoginHref('/login')).toBe(LOGIN_ROUTE);
    expect(buildLoginHref('/login?next=/console')).toBe(LOGIN_ROUTE);
  });

  it('is the link the guest mask offers, so the fallback is always reachable', () => {
    expect(read('components/auth/AccessMasks.tsx')).toContain('loginHref');
    expect(read('components/console/AuthGuard.tsx')).toContain('buildLoginHref(pathname)');
  });
});

describe('the console no longer gates on the cookie', () => {
  it('exports no redirecting gate at all', () => {
    const gate = read('components/console/session-gate.ts');
    // The retired helper is gone as an *export* (the docblock still explains why).
    expect(gate).not.toMatch(/export (async )?function requireSession/);
    expect(gate).not.toMatch(/^\s+requireSession,/m);
    expect(gate).not.toContain("from 'next/navigation'");
    expect(gate).not.toContain("from 'next/headers'");
  });

  it('names the cookie the API actually sets', () => {
    expect(SESSION_COOKIE).toBe('aragon_session');
    expect(read('app/api/auth/login/route.ts')).toContain('serializeSessionCookie');
  });

  it('keeps the /login fallback sanitising ?next= on the server', () => {
    const page = read('app/login/page.tsx');
    expect(page).toContain('sanitizeNextPath');
    // The advisory cookie read only produces the "session expired" hint.
    expect(page).toContain('hasSessionCookieShape');
  });
});
