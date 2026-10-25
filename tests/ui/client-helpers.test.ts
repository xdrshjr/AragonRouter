/**
 * Redirect + clipboard helpers that the console relies on at the boundary between
 * "no session" and "session gone".
 *
 * `AuthGuard` and `CopyButton` are client components, so they cannot be rendered
 * without a DOM (the work package may not add jsdom/testing-library). Both expose
 * their decision logic as exported functions, which is what is exercised here; the
 * components themselves only wire these functions to props.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console',
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

const { buildLoginRedirect } = await import('@/components/console/AuthGuard');
const { copyText } = await import('@/components/ui/CopyButton');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildLoginRedirect (client gate)', () => {
  it('keeps the current console path so the operator lands back where they were', () => {
    expect(buildLoginRedirect('/console/keys')).toBe('/login?next=%2Fconsole%2Fkeys');
    expect(buildLoginRedirect('/console/logs')).toBe('/login?next=%2Fconsole%2Flogs');
  });

  it('falls back to /login for a missing or hostile pathname', () => {
    expect(buildLoginRedirect(null)).toBe('/login');
    expect(buildLoginRedirect(undefined)).toBe('/login');
    expect(buildLoginRedirect('')).toBe('/login');
    expect(buildLoginRedirect('//evil.example')).toBe('/login');
    expect(buildLoginRedirect('https://evil.example')).toBe('/login');
    expect(buildLoginRedirect('console')).toBe('/login');
  });

  it('never redirects to the login page with itself as the next target', () => {
    expect(buildLoginRedirect('/login')).toBe('/login');
    expect(buildLoginRedirect('/login?next=/console')).toBe('/login');
  });
});

describe('copyText', () => {
  it('refuses an empty value without touching the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the async clipboard API in a secure context', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { isSecureContext: true, });
    await expect(copyText('ar-0123456789abcdef0123456789abcdef')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('ar-0123456789abcdef0123456789abcdef');
  });

  it('reports a permission denial instead of throwing', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { isSecureContext: true });
    // No `document` in this environment, so the legacy path cannot run either.
    await expect(copyText('secret')).resolves.toBe(false);
  });

  it('never throws when no clipboard is available at all', async () => {
    await expect(copyText('secret')).resolves.toBe(false);
  });
});
