/**
 * The registration switch in `SettingsPanel` (WP users-admin-ui, C-SETTINGS-WIRE).
 *
 * An administrator writes the value, reads it back and only then reports success; a
 * member sees the stored value read-only and never triggers an administrator request.
 * The wire shape is asserted through the real `/api/admin/settings` handler and through
 * a stubbed `fetch`, so a shape the client cannot trust is never rendered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSnapshot } from '@/components/auth/auth-machine';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { ApiError, getSettings, updateSettings } from '@/components/console/api';
import { SettingsPanel, summarizeDeployment } from '@/components/console/SettingsPanel';
import type { UserPublic } from '@/components/console/types';
import { ToastProvider } from '@/components/ui/Toast';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

function userRow(overrides: Partial<UserPublic> = {}): UserPublic {
  return {
    id: 'user-1',
    username: 'member-one',
    displayName: 'Member One',
    role: 'member',
    status: 'active',
    createdAt: '2025-01-02T03:04:05.000Z',
    updatedAt: '2025-01-02T03:04:05.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

const ADMIN_ROW = userRow({
  id: 'user-admin',
  username: 'admin',
  displayName: 'Operator',
  role: 'admin',
  lastLoginAt: '2025-01-03T00:00:00.000Z',
});

const MEMBER_ROW = userRow();

/** Render one subtree with a toast host (the panels report through it). */
function renderWithToast(node: ReactElement): string {
  return renderToStaticMarkup(<ToastProvider>{node}</ToastProvider>);
}

/** Render a panel for a pinned auth state, exactly how the console shell does it. */
function renderShellState(state: Partial<AuthSnapshot>, node: ReactElement): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <AuthProvider initialState={state}>{node}</AuthProvider>
    </ToastProvider>,
  );
}

/** Capture a rejected call and assert it is the transport error the UI renders. */
async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure, 'this call was expected to be refused').toBeInstanceOf(ApiError);
  return failure as ApiError;
}

describe('registration switch: only the administrator can change it', () => {
  const source = read('components/console/SettingsPanel.tsx');

  it('renders the switch for an administrator and a read-only value for a member', () => {
    const admin = renderShellState(
      { status: 'authenticated', user: { ...ADMIN_ROW }, registrationEnabled: true },
      <SettingsPanel />,
    );
    expect(admin).toContain('Allow self-registration');
    expect(admin).toContain('role="switch"');
    expect(admin).toContain('aria-checked="true"');

    const member = renderShellState(
      { status: 'authenticated', user: { ...MEMBER_ROW }, registrationEnabled: false },
      <SettingsPanel />,
    );
    expect(member).toContain('read-only: closed');
    expect(member).not.toContain('role="switch"');
  });

  it('reads the state, writes it and reads it back before reporting success', () => {
    expect(source).toContain('getSettings');
    expect(source).toContain('updateSettings(');
    expect(source).toContain('<Switch');
    // The re-read is what makes the toast honest: `updateSettings` is followed by a
    // second `getSettings` and by `auth.refresh()` so the dialog follows the switch.
    expect(source).toMatch(/const confirmed = await getSettings\(\)/);
    expect(source).toContain('await auth.refresh()');
    expect(source).toContain('useAuth()');
  });

  it('changes nothing else: no key, provider or account mutation from this panel', () => {
    for (const mutation of [
      'createKey(',
      'revokeKey(',
      'createProvider(',
      'updateProvider(',
      'deleteProvider(',
      'createUser(',
      'deleteUser(',
    ]) {
      expect(source).not.toContain(mutation);
    }
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('stays a read-only view of the deployment', () => {
    const markup = renderWithToast(<SettingsPanel />);
    expect(markup).toContain('Read-only');
    for (const action of ['>Save changes<', '>Revoke key<', '>Delete provider<', '>Create key<']) {
      expect(markup).not.toContain(action);
    }
  });
});

describe('C-SETTINGS-WIRE: the switch is never rendered from a shape it cannot trust', () => {
  interface CapturedCall {
    method: string;
    path: string;
    body: string | null;
  }

  /** Answer every request with one canned payload and record what was sent. */
  function stubSettingsResponse(payload: unknown): CapturedCall[] {
    const captured: CapturedCall[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: new URL(raw, 'http://console.test').pathname,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    vi.stubGlobal('fetch', fake);
    return captured;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the documented wire body and reads the documented wire shape', async () => {
    const captured = stubSettingsResponse({ data: { registration: { enabled: false } } });
    await expect(updateSettings({ enabled: false })).resolves.toEqual({ enabled: false });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('PATCH');
    expect(captured[0]?.path).toBe('/api/admin/settings');
    expect(JSON.parse(captured[0]?.body ?? '{}')).toEqual({ registration: { enabled: false } });
  });

  it('refuses to display a non-boolean flag instead of guessing', async () => {
    stubSettingsResponse({ data: { registration: { enabled: 'yes' } } });
    const failure = await captureApiError(getSettings());
    expect(failure.kind).toBe('protocol');
  });

  it('never puts a non-boolean on the wire, even when a caller passes one', async () => {
    const captured = stubSettingsResponse({ data: { registration: { enabled: true } } });
    await updateSettings({ enabled: 'yes' as unknown as boolean });
    expect(JSON.parse(captured[0]?.body ?? '{}')).toEqual({ registration: { enabled: false } });
  });
});

describe('rework 1.3: a member never triggers an administrator summary request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves an empty summary without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const loaders = summarizeDeployment(false);
    const signal = new AbortController().signal;

    await expect(loaders.loadKeys(signal)).resolves.toEqual([]);
    await expect(loaders.loadProviders(signal)).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still requests both summaries for an administrator', async () => {
    const paths: string[] = [];
    const fake = (async (input: RequestInfo | URL): Promise<Response> => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      paths.push(new URL(raw, 'http://console.test').pathname);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    vi.stubGlobal('fetch', fake);

    const loaders = summarizeDeployment(true);
    const signal = new AbortController().signal;
    await expect(loaders.loadKeys(signal)).resolves.toEqual([]);
    await expect(loaders.loadProviders(signal)).resolves.toEqual([]);
    expect(paths).toEqual(['/api/admin/keys', '/api/admin/providers']);
  });

  it('renders the read-only switch without inventing a summary failure', () => {
    const markup = renderShellState(
      { status: 'authenticated', user: { ...MEMBER_ROW }, registrationEnabled: false },
      <SettingsPanel />,
    );
    expect(markup).toContain('read-only: closed');
    expect(markup).not.toContain('Configuration summary is unavailable');
    // No spinner and no fake "0 / 0" for data that is never requested.
    expect(markup).toContain('need an administrator session');
    expect(markup).not.toContain('Loading summary');
  });
});
