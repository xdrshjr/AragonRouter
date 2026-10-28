/**
 * The console surface of `/console/users` (WP users-admin-ui, acceptance 8): the
 * administrator-only rail entry, the guest/member guard, the account table, the
 * debounced filter contract, the dialog wiring and the create-account validation that
 * mirrors the server.
 *
 * This file is the path acceptance 8 names. The rest of the work package's suite lives
 * one directory per package (`tests/users-admin-ui/`: list state machine, registration
 * switch, real-handler boundary, pagination races, README contract) and runs from the
 * same vitest config, so one command still covers everything.
 *
 * Identity always comes from `useAuth()` (C-AUTH-CONTEXT) and is rendered through
 * `AuthProvider` for a pinned state, so "a member sees the notice, an administrator
 * sees the table" is a rendered assertion rather than a promise. Where only a live DOM
 * could observe the truth (a debounce timer, a click) the source is read and asserted
 * as static evidence - the honest limit without jsdom.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import UsersPage from '@/app/console/users/page';
import type { AuthSnapshot } from '@/components/auth/auth-machine';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { ADMIN_REQUIRED_TITLE } from '@/components/auth/messages';
import { ADMIN_REQUIRED_MESSAGE, ApiError } from '@/components/console/api';
import { CONSOLE_BASE_PATH, NAV_ITEMS, visibleNavItems } from '@/components/console/nav';
import { Sidebar } from '@/components/console/Sidebar';
import type { UserPublic } from '@/components/console/types';
import { describeUserActionFailure } from '@/components/console/users/user-copy';
import { UsersTable } from '@/components/console/users/UsersTable';
import { UsersPanel } from '@/components/console/UsersPanel';
import {
  EMPTY_USER_FORM,
  USER_PASSWORD_MAX_LENGTH,
  buildCreateUserPayload,
  buildUpdateUserPayload,
  describeUserRuleMessage,
  hasUserFormErrors,
  userEditValuesOf,
  validateUserForm,
  validateUserPassword,
  validateUserPasswordBudget,
} from '@/components/console/validation';
import type { UserFormValues } from '@/components/console/validation';
import { ToastProvider } from '@/components/ui/Toast';
import { validatePasswordStrength, validateUsername } from '@/lib/password';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console/users',
  useRouter: () => ({
    replace: () => undefined,
    refresh: () => undefined,
    push: () => undefined,
  }),
}));

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

function valuesWith(overrides: Partial<UserFormValues>): UserFormValues {
  return { ...EMPTY_USER_FORM, ...overrides };
}

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

describe('sidebar entry is administrator-only (C-AUTH-CONTEXT)', () => {
  it('declares the Users section with an admin-only marker', () => {
    const item = NAV_ITEMS.find((candidate) => candidate.href === `${CONSOLE_BASE_PATH}/users`);
    expect(item).toBeDefined();
    expect(item?.label).toBe('Users');
    expect(item?.adminOnly).toBe(true);
    expect(item?.exact).toBe(false);
  });

  it('filters the rail by role', () => {
    const adminHrefs = visibleNavItems(true).map((item) => item.href);
    const guestHrefs = visibleNavItems(false).map((item) => item.href);
    expect(adminHrefs).toContain(`${CONSOLE_BASE_PATH}/users`);
    expect(guestHrefs).not.toContain(`${CONSOLE_BASE_PATH}/users`);
    // Everything else stays visible: the rail is not "admin only".
    expect(guestHrefs).toContain(`${CONSOLE_BASE_PATH}/keys`);
    expect(guestHrefs).toContain(`${CONSOLE_BASE_PATH}/settings`);
    expect(guestHrefs.length).toBe(adminHrefs.length - 1);
  });

  it('hides the link from a guest and from a member, and shows it to an admin', () => {
    const guest = renderShellState({ status: 'guest', registrationEnabled: true }, <Sidebar />);
    const member = renderShellState(
      { status: 'authenticated', user: { ...MEMBER_ROW } },
      <Sidebar />,
    );
    const admin = renderShellState(
      { status: 'authenticated', user: { ...ADMIN_ROW } },
      <Sidebar />,
    );

    expect(guest).not.toContain('/console/users');
    expect(member).not.toContain('/console/users');
    expect(admin).toContain('/console/users');
    // The marker only exists for the administrator who can use the section.
    expect(admin).toContain('Admin');
  });
});

describe('panel guard: no list is requested without an administrator', () => {
  it('mounts the panel from the /console/users route', () => {
    const page = read('app/console/users/page.tsx');
    expect(page).toContain("from '@/components/console/UsersPanel'");
    expect(page).toContain('<UsersPanel />');
    // The page itself never decides identity or fetches anything.
    expect(page).not.toMatch(/\bfetch\(/);
    expect(page).not.toContain('useAuth');
  });

  it('renders the administrator notice for a guest with a way to sign in', () => {
    const markup = renderWithToast(<UsersPanel />);
    expect(markup).toContain(ADMIN_REQUIRED_TITLE);
    expect(markup).toContain('Sign in');
    // Nothing that would need an admin request is rendered.
    expect(markup).not.toContain('Create account');
    expect(markup).not.toContain('Loading accounts');
  });

  it('renders the notice for a signed-in member instead of a broken table', () => {
    const markup = renderShellState(
      { status: 'authenticated', user: { ...MEMBER_ROW } },
      <UsersPanel />,
    );
    expect(markup).toContain(ADMIN_REQUIRED_TITLE);
    expect(markup).toContain('Sign in with another account');
    expect(markup).not.toContain('Create account');
    expect(markup).not.toContain('<table');
  });

  it('mounts the accounts panel for an administrator', () => {
    const markup = renderShellState(
      { status: 'authenticated', user: { ...ADMIN_ROW } },
      <UsersPanel />,
    );
    expect(markup).toContain('Create account');
    expect(markup).toContain('Loading accounts');
    expect(markup).not.toContain(ADMIN_REQUIRED_TITLE);
  });

  it('shows the session skeleton while the identity is still unknown', () => {
    const markup = renderShellState({ status: 'loading' }, <UsersPanel />);
    expect(markup).toContain('Checking your access');
    expect(markup).not.toContain('Create account');
  });
});

describe('account table', () => {
  it('renders username, display name, role, status, last sign-in and created date', () => {
    const markup = renderToStaticMarkup(
      <UsersTable
        rows={[
          ADMIN_ROW,
          MEMBER_ROW,
          userRow({
            id: 'user-3',
            username: 'quiet-one',
            displayName: null,
            status: 'disabled',
          }),
        ]}
        currentUserId={ADMIN_ROW.id}
        onEdit={() => undefined}
        onResetPassword={() => undefined}
        onDelete={() => undefined}
      />,
    );

    const headers = ['Username', 'Display name', 'Role', 'Status', 'Last sign-in', 'Created'];
    for (const header of [...headers, 'Actions']) {
      expect(markup).toContain(header);
    }
    expect(markup).toContain('admin');
    expect(markup).toContain('member-one');
    expect(markup).toContain('Member One');
    // The self row is labelled, so an operator cannot lock themselves out by accident.
    expect(markup).toContain('you');
    expect(markup).toContain('Admin');
    expect(markup).toContain('Disabled');
    // A never-used account is not rendered as a broken date.
    expect(markup).toContain('never');
    expect(markup).toContain('aria-label="Edit member-one"');
    expect(markup).toContain('aria-label="Reset the password of member-one"');
    expect(markup).toContain('aria-label="Delete member-one"');
  });

  it('escapes hostile display names instead of injecting them', () => {
    const markup = renderToStaticMarkup(
      <UsersTable
        rows={[userRow({ displayName: '<img src=x onerror="alert(1)">' })]}
        currentUserId={null}
        onEdit={() => undefined}
        onResetPassword={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img');
  });

  it('keeps the header and explains an empty result', () => {
    const markup = renderToStaticMarkup(
      <UsersTable
        rows={[]}
        currentUserId={null}
        onEdit={() => undefined}
        onResetPassword={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(markup).toContain('Username');
    expect(markup).toContain('No accounts match this view');
  });
});

describe('create-account validation mirrors the server rules', () => {
  it('requires every field', () => {
    const errors = validateUserForm(EMPTY_USER_FORM);
    expect(hasUserFormErrors(errors)).toBe(true);
    expect(errors.username).not.toBeNull();
    expect(errors.password).not.toBeNull();
    expect(errors.role).toBeNull();
  });

  it('rejects a username the store would refuse', () => {
    expect(validateUserForm(valuesWith({ username: 'ab' })).username).toContain('at least 3');
    const valid = valuesWith({ username: 'member-one' });
    expect(validateUserForm({ ...valid, username: 'a'.repeat(33) }).username).toContain(
      'at most 32',
    );
    expect(validateUserForm({ ...valid, username: 'ad min' }).username).toContain(
      'letters, digits',
    );
    expect(validateUserForm(valuesWith({ username: '-dash' })).username).toContain('starting with');
  });

  it('rejects a weak password exactly like validatePasswordStrength', () => {
    const base = valuesWith({ username: 'member-one' });
    expect(validateUserForm({ ...base, password: 'short1' }).password).toContain('at least 8');
    expect(validateUserForm({ ...base, password: 'letters-only' }).password).toContain('one digit');
    expect(validateUserForm({ ...base, password: '12345678' }).password).toContain('one letter');
    expect(validateUserForm({ ...base, password: 'Member-one-9' }).password).toContain(
      'must not contain the username',
    );
    expect(validateUserForm({ ...base, password: 'Quiet-H4rbour-1' }).password).toBeNull();
    // The reset dialog uses the same policy for the target's username.
    expect(validateUserPassword('Quiet-H4rbour-1', 'member-one')).toBeNull();
    expect(validateUserPassword('member-one-9', 'member-one')).toContain('username');
  });

  it('bounds the display name and the role', () => {
    expect(validateUserForm(valuesWith({ displayName: 'x'.repeat(65) })).displayName).toContain(
      'at most 64',
    );
    expect(
      validateUserForm({ ...EMPTY_USER_FORM, role: 'owner' as unknown as 'admin' }).role,
    ).not.toBeNull();
  });

  it('builds the documented POST body', () => {
    const payload = buildCreateUserPayload(
      valuesWith({ username: '  member-one  ', password: 'Quiet-H4rbour-1', displayName: '  ' }),
    );
    expect(payload).toEqual({
      username: 'member-one',
      password: 'Quiet-H4rbour-1',
      role: 'member',
    });
    expect(
      buildCreateUserPayload(
        valuesWith({ username: 'boss', displayName: ' The Boss ', role: 'admin' }),
      ),
    ).toEqual({
      username: 'boss',
      password: '',
      role: 'admin',
      displayName: 'The Boss',
    });
  });

  it('builds the documented PATCH body, clearing an emptied display name', () => {
    expect(userEditValuesOf(ADMIN_ROW)).toEqual({
      displayName: 'Operator',
      role: 'admin',
      status: 'active',
    });
    expect(
      buildUpdateUserPayload({ displayName: '  ', role: 'member', status: 'active' }),
    ).toEqual({
      displayName: null,
      role: 'member',
      status: 'active',
    });
  });
});

/**
 * Rework 3.2 (regression): the create dialog used to accept a password of any length.
 *
 * `src/lib/password.ts` refuses more than 200 characters, while the shared auth-ui
 * validator `validatePasswordInput` (which this form used directly) only enforced the
 * lower bound - so a 300-character password passed the pre-flight check and was only
 * refused by the server. Both ends are now compared instead of trusted: whatever the
 * gateway policy says for a length, the dialog says the same thing before the request.
 */
describe('rework 3.2: the password budget mirrors src/lib/password.ts on both ends', () => {
  /** A password with a letter and a digit that contains no username fragment. */
  function passwordOfLength(length: number): string {
    return `Q${'x'.repeat(Math.max(0, length - 2))}1`;
  }

  it('refuses the length the server refuses, and accepts what it accepts', () => {
    const base = valuesWith({ username: 'member-one' });

    for (const length of [7, 8, 199, 200, 201, 300]) {
      const password = passwordOfLength(length);
      const server = validatePasswordStrength(password, 'member-one');
      const formMessage = validateUserForm({ ...base, password }).password;
      // The dialog agrees with the gateway for every length, in both directions.
      expect(formMessage === null, `length ${length}: client and server disagree`).toBe(server.ok);
    }
  });

  it('names the upper bound in the same sentence the server uses', () => {
    const base = valuesWith({ username: 'member-one' });
    expect(USER_PASSWORD_MAX_LENGTH).toBe(200);
    expect(validateUserForm({ ...base, password: passwordOfLength(201) }).password).toBe(
      'The password must be at most 200 characters.',
    );
    expect(validateUserForm({ ...base, password: passwordOfLength(300) }).password).toContain(
      'at most 200',
    );
    expect(validateUserForm({ ...base, password: passwordOfLength(200) }).password).toBeNull();
    // The reset dialog is the same door and gets the same bound.
    expect(validateUserPassword(passwordOfLength(300), 'member-one')).toContain('at most 200');
    expect(validateUserPassword(passwordOfLength(200), 'member-one')).toBeNull();
    // Non-strings are left to the shared validator, which owns "enter a password".
    expect(validateUserPasswordBudget(null)).toBeNull();
    expect(validateUserPasswordBudget(undefined)).toBeNull();
    expect(validateUserPasswordBudget('Quiet-H4rbour-1')).toBeNull();
  });

  it('wires the same constant into both password inputs', () => {
    const fields = read('components/console/users/user-fields.tsx');
    const reset = read('components/console/users/ResetPasswordDialog.tsx');
    // No magic 200 in either dialog: a change of policy is a one-line edit.
    expect(fields).toContain('maxLength: USER_PASSWORD_MAX_LENGTH');
    expect(reset).toContain('maxLength={USER_PASSWORD_MAX_LENGTH}');
    expect(fields).not.toContain('maxLength: 200');
    expect(reset).not.toContain('maxLength={200}');
  });
});

describe('server rule messages become readable copy', () => {
  it('translates the lockout rules the store raises', () => {
    expect(describeUserRuleMessage('at least one active admin must remain')).toContain(
      'At least one active admin must remain',
    );
    expect(describeUserRuleMessage('you cannot remove your own admin role')).toContain(
      'Ask another administrator',
    );
    expect(describeUserRuleMessage('you cannot disable your own account')).toContain(
      'You cannot disable your own account',
    );
    expect(describeUserRuleMessage('you cannot delete your own account')).toContain(
      'You cannot delete your own account',
    );
    expect(describeUserRuleMessage('username is already taken')).toBe(
      'That username is already taken. Pick another one.',
    );
    expect(describeUserRuleMessage('password must contain at least one digit')).toBe(
      'The password must contain at least one digit.',
    );
    expect(describeUserRuleMessage('user not found')).toContain('no longer exists');
  });

  it('never hides an unknown message and never returns an empty string', () => {
    expect(describeUserRuleMessage('some new rule')).toBe('some new rule');
    expect(describeUserRuleMessage('   ')).toBe('The account change was refused.');
  });

  it('keeps the 403 wording of the transport for a member', () => {
    expect(describeUserActionFailure(new ApiError('forbidden', 403))).toBe(ADMIN_REQUIRED_MESSAGE);
    const selfDelete = new ApiError('you cannot delete your own account', 400);
    expect(describeUserActionFailure(selfDelete)).toContain('You cannot delete your own account');
  });
});

describe('/console/users: a member never gets a white screen (acceptance 6)', () => {
  it('renders the administrator notice from the real page module', () => {
    const markup = renderShellState(
      { status: 'authenticated', user: { ...MEMBER_ROW } },
      <UsersPage />,
    );
    expect(markup).toContain(ADMIN_REQUIRED_TITLE);
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Create account');
  });

  it('decides before the data area exists, so no administrator request can escape', () => {
    const panel = read('components/console/UsersPanel.tsx');
    // The guard runs before `UsersAdminPanel` - the only component that queries.
    expect(panel).toMatch(/if \(!auth\.isAdmin\) \{\s*return \(\s*<UsersAccessNotice/);
    // C-AUTH-CONTEXT: identity comes from the context, never from a probe of its own.
    expect(panel).not.toContain('fetchAuthState');
    expect(panel).not.toContain('/api/auth/session');
    // C-CLIENT-API: one HTTP client for the whole console.
    expect(panel).not.toMatch(/\bfetch\(/);
  });
});

describe('adversarial input: the rule copy and the query are never tricked', () => {
  it('never resolves a prototype key while translating a rule message', () => {
    for (const key of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']) {
      const copy = describeUserRuleMessage(key);
      expect(typeof copy).toBe('string');
      // An unknown message is echoed verbatim - never `Object.prototype[...]`.
      expect(copy).toBe(key);
    }
  });

  it('translates every message the gateway policy can raise', () => {
    const messages = [
      validateUsername(''),
      validateUsername('ab'),
      validateUsername('a'.repeat(33)),
      validateUsername('-lead'),
      validatePasswordStrength('').message,
      validatePasswordStrength('short1').message,
      validatePasswordStrength('x'.repeat(201)).message,
      validatePasswordStrength('lettersonly').message,
      validatePasswordStrength('12345678').message,
      validatePasswordStrength('Member-one-9', 'member-one').message,
      "role must be 'admin' or 'member'",
      "status must be 'active' or 'disabled'",
      'displayName must be a string',
      'displayName must be at most 64 characters',
      'username is already taken',
      'user not found',
    ].filter((message): message is string => typeof message === 'string');

    expect(messages).toHaveLength(16);
    for (const message of messages) {
      const copy = describeUserRuleMessage(message);
      expect(copy, `the dialog would show raw API language: ${message}`).not.toBe(message);
      // Operator copy is a sentence, so it starts with a capital letter.
      expect(copy.charAt(0)).toBe(copy.charAt(0).toUpperCase());
    }
  });
});

describe('dialog and confirmation wiring (static evidence, no DOM available)', () => {
  const panel = read('components/console/UsersPanel.tsx');
  const settings = read('components/console/SettingsPanel.tsx');
  const createDialog = read('components/console/users/CreateUserDialog.tsx');
  const editDialog = read('components/console/users/EditUserDialog.tsx');
  const resetDialog = read('components/console/users/ResetPasswordDialog.tsx');

  it('sends every row action through the shared client and one confirmation', () => {
    expect(createDialog).toContain('createUser(buildCreateUserPayload(values))');
    expect(editDialog).toContain('updateUser(target.id, buildUpdateUserPayload(values))');
    expect(resetDialog).toContain('resetUserPassword(target.id, password)');
    expect(panel).toContain('await action.run(() => deleteUser(target.id))');
    expect(panel).toContain('<ConfirmDialog');
    expect(panel).toContain('confirmLabel="Delete account"');
    expect(panel).toContain('destructive');
    // A row button only opens the dialog; nothing is deleted on a single click.
    expect(panel).toMatch(
      /onDelete: \(row: UserPublic\) => \{\s*action\.reset\(\);\s*setDeleteTarget\(row\);/,
    );
    // A settled create closes the dialog and reloads the first page before the toast.
    expect(panel).toMatch(/const handleCreated = useCallback\(/);
    expect(panel).toMatch(/handleCreated = useCallback\([\s\S]{0,160}?refresh\(\);/);
  });

  it('reports every settled action through the toast host', () => {
    const titles = ['Account created', 'Account updated', 'Password reset', 'Account deleted'];
    for (const title of titles) {
      expect(panel).toContain(`title: '${title}'`);
    }
  });

  it('shows the server rule copy inline in the dialog that failed', () => {
    for (const dialog of [createDialog, editDialog, resetDialog]) {
      expect(dialog).toMatch(
        /error=\{action\.error \? describeUserActionFailure\(action\.error\) : null\}/,
      );
    }
    expect(createDialog).toContain('error={errors[field.key]}');
    expect(resetDialog).toContain('error={passwordError}');
  });

  it('debounces the search box and keeps an explicit submit immediate', () => {
    expect(panel).toContain('const next = normalizeUserSearch(searchInput);');
    expect(panel).toContain('}, USER_SEARCH_DEBOUNCE_MS);');
    expect(panel).toContain('clearTimeout(timer);');
    expect(panel).toMatch(/setSearch\(normalizeUserSearch\(searchInput\)\);/);
  });

  it('keeps the settings toggle on the published client functions', () => {
    expect(settings).toContain('updateSettings({ enabled: next })');
    expect(settings).toContain('const confirmed = await getSettings();');
    expect(settings).toContain('await auth.refresh()');
    expect(settings).not.toContain('fetchAuthState');
    expect(settings).not.toMatch(/\bfetch\(/);
  });
});

describe('the panel stays inside the clean-code budget', () => {
  const USERS_DIR = 'components/console/users';

  /** Every source module of the user-management feature. */
  function userModules(): string[] {
    return readdirSync(join(SRC, USERS_DIR))
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => `${USERS_DIR}/${entry}`);
  }

  it('keeps the panel and every user module under 1000 lines and 100 columns', () => {
    const files = ['components/console/UsersPanel.tsx', ...userModules()];
    // The suite would silently pass on an empty directory: prove it found the modules.
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const lines = read(file).split(/\r?\n/);
      expect(lines.length, `${file} exceeds MAX_FILE_LINES (1000)`).toBeLessThan(1000);
      const longLines = lines.filter((line) => line.length > 100);
      expect(longLines, `${file} exceeds MAX_LINE_LENGTH (100)`).toEqual([]);
    }
  });

  it('leaves only orchestration in the panel, not seven components in one file', () => {
    const panel = read('components/console/UsersPanel.tsx');
    for (const component of [
      'UsersTable',
      'UsersAccessNotice',
      'UsersListSection',
      'CreateUserDialog',
      'EditUserDialog',
      'ResetPasswordDialog',
    ]) {
      expect(panel, `${component} is still defined inside UsersPanel.tsx`).not.toContain(
        `function ${component}`,
      );
      expect(panel).toContain(`@/components/console/users/${component}'`);
    }
    expect(panel).not.toContain('function TextField');
    expect(panel).not.toContain('function SelectField');
    expect(panel).not.toContain('function DialogActions');
  });

  it('keeps the public surface importable from UsersPanel.tsx itself', () => {
    const panel = read('components/console/UsersPanel.tsx');
    for (const exported of [
      'USER_PAGE_SIZE',
      'USER_SEARCH_DEBOUNCE_MS',
      'describeUserActionFailure',
      'mergeUserPages',
    ]) {
      expect(panel).toContain(exported);
    }
    // ... and the re-export is a re-export, not a second definition.
    expect(panel).toMatch(/export \{\s*USER_PAGE_SIZE,/);
  });
});

/**
 * Rework 3.3 (regression): acceptance 8 names `tests/ui/users-panel.test.tsx`, and the
 * suite used to live only at `tests/users-admin-ui/users-panel-ui.test.tsx`. Governance
 * permits `tests/<wpId>/` for a package, but a runbook, a traceability row or a reviewer
 * that looks for the acceptance path must find it. This block is the guard on the path
 * itself: it fails if this file is moved or renamed, if the console config stops
 * collecting it, or if the split suite in `tests/users-admin-ui/` is duplicated here.
 */
describe('rework 3.3: the panel suite lives at the path acceptance 8 names', () => {
  const selfPath = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  const testsDir = fileURLToPath(new URL('.', import.meta.url));
  const splitDir = fileURLToPath(new URL('../users-admin-ui/', import.meta.url));

  it('is tests/ui/users-panel.test.tsx and is collected by the console config', () => {
    expect(selfPath.endsWith('/tests/ui/users-panel.test.tsx')).toBe(true);
    const config = readFileSync(join(testsDir, 'vitest.config.ts'), 'utf8');
    // The literal glob that makes `npx vitest run --config tests/ui/vitest.config.ts`
    // execute this file; removing it must break here and not in silence.
    expect(config).toContain("'tests/ui/**/*.test.tsx'");
  });

  it('keeps the rest of the package split, unduplicated, inside the budget', () => {
    const files = readdirSync(splitDir).filter((entry) => /\.test\.tsx?$/.test(entry));

    // Each responsibility keeps its own home next to this one.
    for (const expected of [
      'users-list-state.test.tsx',
      'settings-switch.test.tsx',
      'users-boundary.test.ts',
      'users-pagination-races.test.ts',
      'readme-contract.test.ts',
    ]) {
      expect(files, `${expected} is missing from the split suite`).toContain(expected);
    }
    // The panel suite is not left behind as a second copy that would run twice.
    expect(files).not.toContain('users-panel-ui.test.tsx');

    for (const entry of [...files, 'users-panel.test.tsx']) {
      const source = entry === 'users-panel.test.tsx'
        ? readFileSync(fileURLToPath(import.meta.url), 'utf8')
        : readFileSync(join(splitDir, entry), 'utf8');
      const lines = source.split(/\r?\n/);
      expect(lines.length, `${entry} exceeds MAX_FILE_LINES (1000)`).toBeLessThan(1000);
      const longLines = lines.filter((line) => line.length > 100);
      expect(longLines, `${entry} exceeds MAX_LINE_LENGTH (100)`).toEqual([]);
    }
  });
});
