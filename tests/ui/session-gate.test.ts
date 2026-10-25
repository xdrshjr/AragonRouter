/**
 * Server-side session gate (acceptance: "未登录访问 /console 回登录页").
 *
 * `src/components/console/session-gate.ts` is a *server* module: it reads the
 * cookie through `next/headers` and calls `next/navigation`'s `redirect`. Both are
 * mocked here so the gate's own decision (redirect or not, and to which URL) can be
 * asserted without a running Next server. The gateway side of the same criterion -
 * that the cookie this gate accepts is the one C3 really mints - lives in
 * `boundary.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Sentinel thrown by the mocked `redirect`, exactly like Next's control flow. */
class RedirectSignal extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`NEXT_REDIRECT:${target}`);
    this.name = 'RedirectSignal';
    this.target = target;
  }
}

const cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get(name: string): { name: string; value: string } | undefined {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

const { LOGIN_ROUTE, buildLoginHref, hasSessionCookieShape, requireSession } = await import(
  '@/components/console/session-gate'
);

/** A token shaped exactly like the one C3 sets: `<expiresAtMs>.<64 hex>`. */
const VALID_SHAPED_TOKEN = `${Date.now() + 86_400_000}.${'a1b2c3d4'.repeat(8)}`;

beforeEach(() => {
  cookieJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run `requireSession` and return the redirect target, or `null` when it allowed. */
async function gate(nextPath: string): Promise<string | null> {
  try {
    await requireSession(nextPath);
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
}

describe('hasSessionCookieShape', () => {
  it('accepts a C3 token and rejects everything else', () => {
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
});

describe('requireSession', () => {
  it('sends an anonymous visitor of /console to the login page with a next target', async () => {
    expect(await gate('/console')).toBe('/login?next=%2Fconsole');
  });

  it('sends an anonymous visitor of a sub-page to the login page', async () => {
    expect(await gate('/console/providers')).toBe('/login?next=%2Fconsole%2Fproviders');
    expect(await gate('/console/logs')).toBe('/login?next=%2Fconsole%2Flogs');
  });

  it('rejects a malformed cookie instead of trusting it', async () => {
    cookieJar.set('aragon_session', 'forged');
    expect(await gate('/console')).toBe('/login?next=%2Fconsole');
  });

  it('rejects an empty cookie value', async () => {
    cookieJar.set('aragon_session', '');
    expect(await gate('/console')).toBe('/login?next=%2Fconsole');
  });

  it('lets a C3-shaped cookie through (the API still proves it)', async () => {
    cookieJar.set('aragon_session', VALID_SHAPED_TOKEN);
    expect(await gate('/console')).toBeNull();
  });

  it('ignores unrelated cookies', async () => {
    cookieJar.set('aragon_session_hint', VALID_SHAPED_TOKEN);
    cookieJar.set('other', VALID_SHAPED_TOKEN);
    expect(await gate('/console')).toBe('/login?next=%2Fconsole');
  });
});
