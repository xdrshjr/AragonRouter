/**
 * Regression tests for REQUIRED CHANGE #1 of the console-ui rework.
 *
 * Defect: a 401 raised by a *mutation* was swallowed. `KeysPanel` and
 * `ProvidersPanel` filtered the action error with
 * `isUnauthorized(action.error) ? null : message` and only watched the *query*
 * error, so an expired session made 'Create key', 'Revoke', 'Add/Edit/Delete
 * provider', the `enabled` toggle and 'Test connection' complete with no message,
 * no dialog change and no redirect - the click silently did nothing.
 *
 * The fix removes both halves of that trap:
 *   1. `api.ts` raises a session-expiry signal at its single request choke point,
 *      so *any* 401 - query or mutation - reaches the shell (`AuthGuard`), which
 *      subscribed once; nothing is left for a panel to forget.
 *   2. Both panels additionally pass their action error to
 *      `useSessionExpiryRedirect`, and no longer filter the message out, so the
 *      failure is also visible in the dialog/live region.
 *
 * These tests drive the real typed client against a stubbed `fetch`, and read the
 * panel sources for the wiring that a node environment cannot execute (no DOM, no
 * testing-library - the spec forbids adding the dependency).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  SESSION_EXPIRED_MESSAGE,
  createKey,
  createProvider,
  deleteProvider,
  getSession,
  getStats,
  listKeys,
  listLogs,
  listProviders,
  revokeKey,
  signIn,
  signOut,
  testProvider,
  updateProvider,
} from '@/components/console/api';
import {
  notifySessionExpired,
  resetSessionExpiredListeners,
  sessionExpiryListenerCount,
  subscribeSessionExpired,
  watchSessionExpiry,
} from '@/components/console/session-expiry';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/** Every `/api/admin/**` call answers 401, exactly like an expired cookie. */
function respondUnauthorized(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

async function captureError(call: Promise<unknown>): Promise<ApiError> {
  const error = await call.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

beforeEach(() => {
  resetSessionExpiredListeners();
});

afterEach(() => {
  resetSessionExpiredListeners();
  vi.unstubAllGlobals();
});

describe('any admin 401 raises the session-expiry signal', () => {
  /**
   * The nine calls the rework finding names, taken from the boundary suite: the
   * five mutations plus the four queries the console performs.
   */
  /** A minimal valid C6 create payload; only the URL/method matter here. */
  const providerInput = {
    name: 'Anthropic',
    protocol: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
  };

  const calls: readonly [string, () => Promise<unknown>][] = [
    ['createKey', () => createKey('expiring')],
    ['revokeKey', () => revokeKey('key-1')],
    ['createProvider', () => createProvider(providerInput)],
    ['updateProvider', () => updateProvider('prov-1', { enabled: false })],
    ['deleteProvider', () => deleteProvider('prov-1')],
    ['testProvider', () => testProvider('prov-1')],
    ['listKeys', () => listKeys()],
    ['listProviders', () => listProviders()],
    ['getStats', () => getStats('24h')],
    ['listLogs', () => listLogs({ limit: 1 })],
    ['getSession', () => getSession()],
  ];

  for (const [name, call] of calls) {
    it(`${name} surfaces ApiError(401) *and* announces the expiry`, async () => {
      respondUnauthorized();
      const expired = vi.fn();
      subscribeSessionExpired(expired);

      const error = await captureError(call());

      expect(error.status).toBe(401);
      expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
      // This is the regression: the signal fires for mutations too, so the shell
      // navigates to /login even when the panel ignores the returned error.
      expect(expired).toHaveBeenCalledTimes(1);
    });
  }

  it('does not announce an expiry for a wrong password (POST /session)', async () => {
    respondUnauthorized();
    const expired = vi.fn();
    subscribeSessionExpired(expired);

    const error = await captureError(signIn('wrong-password'));

    expect(error.status).toBe(401);
    // The login form must show this inline; navigating away from /login would be
    // an infinite loop.
    expect(expired).not.toHaveBeenCalled();
  });

  it('does not announce an expiry for a non-401 failure', async () => {
    respondWith({ error: { message: 'database is locked' } }, 500);
    const expired = vi.fn();
    subscribeSessionExpired(expired);

    const error = await captureError(listKeys());

    expect(error.status).toBe(500);
    expect(error.message).toBe('database is locked');
    expect(expired).not.toHaveBeenCalled();
  });

  it('never announces an expiry on success, and sign-out clears the cookie without one', async () => {
    const expired = vi.fn();
    subscribeSessionExpired(expired);

    respondWith({ data: [] });
    await expect(listKeys()).resolves.toEqual([]);
    expect(expired).not.toHaveBeenCalled();

    respondWith({ data: { ok: true } });
    await expect(signOut()).resolves.toBeUndefined();
    expect(expired).not.toHaveBeenCalled();
  });
});

describe('the expiry signal is safe to fan out', () => {
  it('fires each watcher once, however many 401s arrive', async () => {
    respondUnauthorized();
    const redirect = vi.fn();
    const watcher = watchSessionExpiry(redirect);

    await captureError(listKeys());
    await captureError(createKey('second'));
    await captureError(revokeKey('key-1'));

    // Three 401s, one navigation: parallel failures must not fight over history.
    expect(redirect).toHaveBeenCalledTimes(1);

    watcher.unsubscribe();
    await captureError(listKeys());
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(sessionExpiryListenerCount()).toBe(0);
  });

  it('a throwing subscriber never hides the ApiError or blocks the others', async () => {
    respondUnauthorized();
    subscribeSessionExpired(() => {
      throw new Error('subscriber exploded');
    });
    const healthy = vi.fn();
    subscribeSessionExpired(healthy);

    const error = await captureError(listKeys());

    expect(error.status).toBe(401);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('carries no payload, so nothing sensitive can leak through it', () => {
    const listener = vi.fn();
    subscribeSessionExpired(listener);
    notifySessionExpired();
    expect(listener).toHaveBeenCalledWith();
  });
});

describe('panel wiring (static evidence: effects cannot run without a DOM)', () => {
  const panels = ['components/console/KeysPanel.tsx', 'components/console/ProvidersPanel.tsx'];

  for (const file of panels) {
    it(`${file} routes its action error into the session redirect`, () => {
      const source = read(file);
      // The panel must watch what `useAsyncAction` reports, not just the query.
      expect(source).toMatch(/useSessionExpiryRedirect\(action\.error\)/);
      // ...and must not drop the 401 message any more: that filter is the defect.
      expect(source).not.toMatch(/isUnauthorized\(action\.error\)/);
    });
  }

  it('every panel that mutates through useAsyncAction wires the redirect', () => {
    for (const file of ['components/console/KeysPanel.tsx', 'components/console/ProvidersPanel.tsx']) {
      const source = read(file);
      expect(source).toContain('useAsyncAction()');
      expect(source).toContain('useSessionExpiryRedirect(action.error)');
    }
  });

  it('the shell subscribes to the signal and answers it with the sign-in dialog', () => {
    const guard = read('components/console/AuthGuard.tsx');
    expect(guard).toContain('subscribeSessionExpired(');
    // Guest-first: an expiry re-opens the dialog with the expiry notice and re-reads
    // the session, instead of navigating to /login and losing the operator's place.
    expect(guard).toContain("openLogin('login', SESSION_EXPIRED_NOTICE)");
    expect(guard).toContain('void current.refresh()');
    expect(guard).not.toContain('buildLoginRedirect');
    expect(guard).not.toContain('router.replace(');
  });

  it('the transport layer raises the signal for every 401 except the sign-in probe', () => {
    const api = read('components/console/api.ts');
    expect(api).toContain('notifySessionExpired()');
    // Guarded so a wrong password on /login does not navigate to /login.
    expect(api).toMatch(/path === '\/session' && method === 'POST'/);
  });

  it('the mutation failure stays visible in the UI as well', () => {
    // KeysPanel: the confirm dialog renders the message (Modal puts role="alert"
    // on it); ProvidersPanel: the inline banner and the form dialog do.
    expect(read('components/console/KeysPanel.tsx')).toContain('error={action.error?.message ?? null}');
    expect(read('components/console/ProvidersPanel.tsx')).toContain(
      'const inlineError = action.error?.message ?? null;',
    );
    expect(read('components/ui/Modal.tsx')).toContain('role="alert"');
  });
});
