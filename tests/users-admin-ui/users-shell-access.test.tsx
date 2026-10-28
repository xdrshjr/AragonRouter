/**
 * Acceptance 1 and 6 through the *real shell*, not the panel in isolation.
 *
 * `tests/ui/users-panel.test.tsx` renders `Sidebar` and `UsersPanel`
 * separately. That leaves the shipped path uncovered: what a visitor actually meets is
 * `AuthGuard`, which decides between the sign-in mask, the "administrator access
 * required" mask and the page. A member typing `/console/users` must land on the notice
 * (no blank surface, no crash, no dead link in the rail), and an administrator must get
 * the account page with the Users entry marked "Admin".
 *
 * The second half pins the C-AUTH-CONTEXT rule the panel is not allowed to break: the
 * account surface reads identity from `useAuth()` and speaks HTTP only through
 * `api.ts`. A panel that grew its own `fetch` or its own session probe would work in
 * isolation and drift the moment the context changed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/components/auth/AuthProvider';
import type { AuthSnapshot } from '@/components/auth/auth-machine';
import {
  ADMIN_REQUIRED_DESCRIPTION,
  ADMIN_REQUIRED_TITLE,
  GUEST_MASK_TITLE,
} from '@/components/auth/messages';
import { AuthGuard } from '@/components/console/AuthGuard';
import { SettingsPanel } from '@/components/console/SettingsPanel';
import { CONSOLE_BASE_PATH, NAV_ITEMS, findNavItem } from '@/components/console/nav';
import type { UserPublic } from '@/components/console/types';
import { ToastProvider } from '@/components/ui/Toast';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console/users',
  useRouter: () => ({
    replace: () => undefined,
    refresh: () => undefined,
    push: () => undefined,
  }),
}));

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const USERS_ROUTE = `${CONSOLE_BASE_PATH}/users`;
/** Rendered as the page body: it must only appear when the shell decided to mount it. */
const PANEL_SENTINEL = 'data-testid="account-panel-mounted"';

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

function account(overrides: Partial<UserPublic> = {}): UserPublic {
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

/** Render the real console shell for a pinned session, as a browser would receive it. */
function renderShell(state: Partial<AuthSnapshot>, child: ReactElement): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <AuthProvider initialState={state}>
        <AuthGuard>{child}</AuthGuard>
      </AuthProvider>
    </ToastProvider>,
  );
}

const pageChild = <div data-testid="account-panel-mounted">accounts</div>;

describe('acceptance 1: the Users entry exists only for an administrator', () => {
  it('a guest at /console/users gets the sign-in mask and no Users link', () => {
    const html = renderShell({ status: 'guest', registrationEnabled: true }, pageChild);
    expect(html).toContain(GUEST_MASK_TITLE);
    expect(html).not.toContain(`href="${USERS_ROUTE}"`);
    expect(html).not.toContain(PANEL_SENTINEL);
  });

  it('a member at /console/users gets the administrator notice and no Users link', () => {
    const html = renderShell({ status: 'authenticated', user: account() }, pageChild);
    // Not a blank page, not a crash: the owner of the shell names the reason.
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain(ADMIN_REQUIRED_TITLE);
    expect(html).toContain(ADMIN_REQUIRED_DESCRIPTION);
    // The member is still inside the console: the rail and the top bar are there.
    expect(html).toContain('aria-label="Console sections"');
    expect(html).toContain(`href="${CONSOLE_BASE_PATH}/keys"`);
    // …but the administrator section is absent, and the page body never mounted.
    expect(html).not.toContain(`href="${USERS_ROUTE}"`);
    expect(html).not.toContain(PANEL_SENTINEL);
  });

  it('an administrator gets the account page and the marked Users entry', () => {
    const adminUser = account({ id: 'user-admin', username: 'admin', role: 'admin' });
    const html = renderShell({ status: 'authenticated', user: adminUser }, pageChild);
    expect(html).toContain(PANEL_SENTINEL);
    expect(html).toContain(`href="${USERS_ROUTE}"`);
    expect(html).not.toContain(ADMIN_REQUIRED_TITLE);
    // `aria-current="page"` marks the active row, and only the Users row carries it:
    // the rail is rendered twice (desktop rail + mobile drawer), so both counts agree.
    const activeMarks = html.match(/aria-current="page"/g) ?? [];
    const usersLinks = html.match(new RegExp(`href="${USERS_ROUTE}"`, 'g')) ?? [];
    expect(usersLinks.length).toBeGreaterThan(0);
    expect(activeMarks.length).toBe(usersLinks.length);
  });

  it('keeps the section title resolvable for the top bar on the users route', () => {
    const item = findNavItem(USERS_ROUTE);
    expect(item.href).toBe(USERS_ROUTE);
    expect(item.label).toBe('Users');
    expect(item.hint.length).toBeGreaterThan(0);
    // The title is resolved from the full list, so it also works for a member who
    // reached the route by hand and sees the mask instead of the page.
    expect(NAV_ITEMS.map((entry) => entry.href)).toContain(USERS_ROUTE);
  });

  /**
   * Documents the precedence the shell applies to *every* panel, not just the account
   * list: a `member` never sees the page body. That is why the read-only registration
   * switch `SettingsPanel` implements for a member is a defence-in-depth branch and not
   * the shipped screen - the mask is what a member actually meets.
   */
  it('a member at /console/settings sees the mask instead of the read-only switch', () => {
    const html = renderShell(
      { status: 'authenticated', user: account() },
      <SettingsPanel />,
    );
    expect(html).toContain(ADMIN_REQUIRED_TITLE);
    expect(html).not.toContain('Allow self-registration');
    expect(html).not.toContain('read-only:');
  });
});

describe('C-AUTH-CONTEXT: the account surface reads identity, it never fetches it', () => {
  const USER_MODULES = readdirSync(join(SRC, 'components/console/users')).map((name) =>
    join('components/console/users', name),
  );
  const ACCOUNT_SOURCES = [
    'components/console/UsersPanel.tsx',
    'components/console/Sidebar.tsx',
    'components/console/SettingsPanel.tsx',
    'app/console/users/page.tsx',
    ...USER_MODULES,
  ];

  it('no account module opens its own session probe', () => {
    for (const file of ACCOUNT_SOURCES) {
      const source = read(file);
      expect(source, `${file} must not probe the session itself`).not.toContain('fetchAuthState');
      expect(source, `${file} must not call getSession()`).not.toMatch(/\bgetSession\b/);
    }
  });

  it('no account module talks to fetch directly - api.ts is the only client', () => {
    for (const file of ACCOUNT_SOURCES) {
      const source = read(file);
      expect(source, `${file} must go through components/console/api`).not.toMatch(/\bfetch\s*\(/);
      expect(source, `${file} must not build its own XMLHttpRequest`).not.toContain(
        'XMLHttpRequest',
      );
    }
  });

  it('every module that needs an identity asks the auth context', () => {
    for (const file of [
      'components/console/UsersPanel.tsx',
      'components/console/Sidebar.tsx',
      'components/console/SettingsPanel.tsx',
      'components/console/users/CreateUserDialog.tsx',
      'components/console/users/EditUserDialog.tsx',
      'components/console/users/ResetPasswordDialog.tsx',
    ]) {
      expect(read(file), `${file} must use the shared auth context`).toContain(
        "from '@/components/auth/auth-context'",
      );
    }
  });

  it('the settings switch writes through the two published client functions', () => {
    const source = read('components/console/SettingsPanel.tsx');
    expect(source).toContain('getSettings');
    expect(source).toContain('updateSettings');
    // The wire body lives in api.ts; the panel passes `{enabled}` only.
    expect(source).not.toContain('registration: { enabled');
  });
});
