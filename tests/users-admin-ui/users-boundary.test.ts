/**
 * Boundary tests: `/console/users` against the real route handlers (WP users-admin-ui
 * consuming C-USERS-WIRE, C-SETTINGS-WIRE and C-AUTH-WIRE).
 *
 * Every call below goes through the shared console client (`api.ts`) with `fetch`
 * wired to the actual Next route handlers by `tests/ui/support/admin-harness.ts`, so the
 * panel is tested against the account API it will really meet: 401 for a guest, 403 for
 * a member, 400 with the store's own rule wording for a lockout, 404 for a stale row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_REQUIRED_MESSAGE,
  ApiError,
  createUser,
  deleteUser,
  describeApiFailure,
  fetchAuthState,
  getSettings,
  isForbidden,
  isUnauthorized,
  listUsers,
  login,
  register,
  resetUserPassword,
  updateSettings,
  updateUser,
} from '@/components/console/api';
import { CONSOLE_BASE_PATH, visibleNavItems } from '@/components/console/nav';
import type { UserPublic } from '@/components/console/types';
import {
  describeUserActionFailure,
  mergeUserPages,
} from '@/components/console/users/user-copy';
import { describeUserRuleMessage } from '@/components/console/validation';
import { createCaptcha } from '@/lib/captcha';
import {
  TEST_ADMIN_PASSWORD,
  installAdminHarness,
  prepareGatewayEnv,
} from '../ui/support/admin-harness';
import type { AdminHarness } from '../ui/support/admin-harness';

/** A challenge whose answer this test knows (the HTTP layer never chooses it). */
function solvedCaptcha(answer = 'ABCDE'): { challengeId: string; answer: string } {
  const challenge = createCaptcha(Date.now(), { answer });
  return { challengeId: challenge.id, answer };
}

/** Sign in as the bootstrap administrator `ensureBootstrapAdmin` creates. */
function signInBootstrapAdmin(): Promise<UserPublic> {
  const captcha = solvedCaptcha();
  return login({
    username: 'admin',
    password: TEST_ADMIN_PASSWORD,
    challengeId: captcha.challengeId,
    captchaAnswer: captcha.answer,
  });
}

/** Sign in as any other account - a fresh challenge every time (C-CAPTCHA). */
function signInAccount(username: string, password: string): Promise<UserPublic> {
  const captcha = solvedCaptcha();
  return login({
    username,
    password,
    challengeId: captcha.challengeId,
    captchaAnswer: captcha.answer,
  });
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

/** An account whose password satisfies the gateway policy for its own name. */
function createMemberAccount(username: string, displayName?: string): Promise<UserPublic> {
  const input: { username: string; password: string; displayName?: string } = {
    username,
    password: 'Quiet-H4rbour-1',
  };
  if (displayName !== undefined) input.displayName = displayName;
  return createUser(input);
}

describe('C-USERS-WIRE through the real handlers', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  /** Sign in as the bootstrap administrator (captcha solved locally). */
  async function signInAsAdmin(): Promise<UserPublic> {
    const captcha = solvedCaptcha();
    return login({
      username: 'admin',
      password: TEST_ADMIN_PASSWORD,
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });
  }

  async function createMember(username: string): Promise<UserPublic> {
    return createUser({ username, password: 'Quiet-H4rbour-1', role: 'member' });
  }

  it('lists the first page, follows the cursor and applies every filter', async () => {
    await signInAsAdmin();
    await createMember('member-one');
    const second = await createMember('member-two');
    await createMember('member-three');

    const firstPage = await listUsers({ limit: 2 });
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listUsers({ limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.nextCursor).toBeNull();
    const merged = mergeUserPages(firstPage.data, secondPage.data);
    expect(merged).toHaveLength(4);
    expect(new Set(merged.map((row) => row.id)).size).toBe(4);

    const adminsOnly = await listUsers({ role: 'admin' });
    expect(adminsOnly.data.map((row) => row.username)).toEqual(['admin']);

    const searched = await listUsers({ search: 'MEMBER-TWO' });
    expect(searched.data.map((row) => row.username)).toEqual(['member-two']);

    // Status is filtered server-side, so a disabled account disappears from the
    // default view exactly like the UI's "Any status" filter would show.
    await updateUser(second.id, { status: 'disabled' });
    const disabled = await listUsers({ status: 'disabled' });
    expect(disabled.data.map((row) => row.id)).toEqual([second.id]);
  });

  it('reports a duplicate username with the copy the dialog shows', async () => {
    await signInAsAdmin();
    const created = await createMember('member-one');
    expect(created.role).toBe('member');

    const failure = await createUser({ username: 'member-one', password: 'Quiet-H4rbour-1' }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
    expect(describeUserRuleMessage((failure as ApiError).message)).toBe(
      'That username is already taken. Pick another one.',
    );
  });

  it('refuses to lock the instance out and surfaces the readable reason', async () => {
    const admin = await signInAsAdmin();
    const other = await createUser({
      username: 'admin-two',
      password: 'Quiet-H4rbour-2',
      role: 'admin',
    });
    // Sign in as the second administrator so the actor is not the last active admin.
    const captcha = solvedCaptcha();
    await login({
      username: 'admin-two',
      password: 'Quiet-H4rbour-2',
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });

    // Disabling another administrator is allowed while two remain.
    await expect(updateUser(admin.id, { status: 'disabled' })).resolves.toMatchObject({
      status: 'disabled',
    });

    // Now `admin-two` is the only active administrator: demoting it is refused.
    const demote = await updateUser(other.id, { role: 'member' }).catch((error: unknown) => error);
    expect((demote as ApiError).status).toBe(400);
    expect(describeUserActionFailure(demote as ApiError)).toBe(
      'At least one active admin must remain. Promote another account to admin first.',
    );

    const admins = await listUsers({ role: 'admin', status: 'active' });
    expect(admins.data.map((row) => row.id)).toEqual([other.id]);
  });

  it('refuses a self-lockout with readable copy while another admin remains', async () => {
    await signInAsAdmin();
    const other = await createUser({
      username: 'admin-two',
      password: 'Quiet-H4rbour-2',
      role: 'admin',
    });
    const captcha = solvedCaptcha();
    const self = await login({
      username: 'admin-two',
      password: 'Quiet-H4rbour-2',
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });
    expect(self.id).toBe(other.id);

    const demote = await updateUser(self.id, { role: 'member' }).catch((error: unknown) => error);
    expect(describeUserActionFailure(demote as ApiError)).toBe(
      'You cannot remove your own admin role. Ask another administrator to do it.',
    );

    const disable = await updateUser(self.id, { status: 'disabled' }).catch(
      (error: unknown) => error,
    );
    expect(describeUserActionFailure(disable as ApiError)).toBe(
      'You cannot disable your own account. Ask another administrator to do it.',
    );

    const remove = await deleteUser(self.id).catch((error: unknown) => error);
    expect(describeUserActionFailure(remove as ApiError)).toBe(
      'You cannot delete your own account. Ask another administrator to do it.',
    );

    // Nothing was written: both administrators are still active.
    const active = await listUsers({ status: 'active', role: 'admin' });
    expect(active.data).toHaveLength(2);
    expect(active.data.map((row) => row.id)).toContain(self.id);
    expect(await listUsers({ search: 'admin-two' }).then((page) => page.data[0]?.status)).toBe(
      'active',
    );
  });

  it('edits, resets and deletes an account', async () => {
    await signInAsAdmin();
    const member = await createMember('member-one');

    const renamed = await updateUser(member.id, {
      displayName: 'Member One',
      role: 'admin',
      status: 'active',
    });
    expect(renamed.displayName).toBe('Member One');
    expect(renamed.role).toBe('admin');

    await expect(resetUserPassword(member.id, 'Quiet-H4rbour-2')).resolves.toBeUndefined();
    await expect(deleteUser(member.id)).resolves.toBeUndefined();

    const remaining = await listUsers({ search: 'member-one' });
    expect(remaining.data).toEqual([]);
  });

  it('answers 403 for a member session and keeps the console copy', async () => {
    const captcha = solvedCaptcha();
    const member = await register({
      username: 'member-one',
      password: 'Quiet-H4rbour-1',
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });
    expect(member.role).toBe('member');

    const failure = await listUsers().catch((error: unknown) => error);
    expect(isForbidden(failure)).toBe(true);
    expect(describeApiFailure(failure)).toBe(ADMIN_REQUIRED_MESSAGE);
  });
});

describe('C-SETTINGS-WIRE through the real handler', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('round-trips the switch the sign-up form reads', async () => {
    const captcha = solvedCaptcha();
    await login({
      username: 'admin',
      password: TEST_ADMIN_PASSWORD,
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });

    await expect(getSettings()).resolves.toEqual({ enabled: true });
    await expect(updateSettings({ enabled: false })).resolves.toEqual({ enabled: false });
    // The console re-reads the value; the server is the single source of truth.
    await expect(getSettings()).resolves.toEqual({ enabled: false });
    await expect(updateSettings({ enabled: true })).resolves.toEqual({ enabled: true });
    expect(harness.calls.some((call) => call.path === '/api/admin/settings')).toBe(true);
  });
});

describe('adversarial input through the real handlers', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('treats % and _ in the search box literally instead of widening the query', async () => {
    await signInBootstrapAdmin();
    await createMemberAccount('alpha-one', '100% uptime');
    await createMemberAccount('beta-two');

    // A lone wildcard must not degenerate into "match everything".
    expect((await listUsers({ search: '%' })).data.map((row) => row.username)).toEqual([
      'alpha-one',
    ]);
    expect((await listUsers({ search: '0%' })).data.map((row) => row.username)).toEqual([
      'alpha-one',
    ]);
    expect((await listUsers({ search: '_' })).data).toEqual([]);
    expect((await listUsers({ search: '\\' })).data).toEqual([]);
    // Case-insensitive, like the uniqueness rule the same column carries.
    expect((await listUsers({ search: 'ALPHA' })).data.map((row) => row.username)).toEqual([
      'alpha-one',
    ]);
  });

  it('answers 400 for a filter value the UI cannot produce', async () => {
    await signInBootstrapAdmin();
    const cases = [
      { query: 'role=owner', message: "role must be 'admin' or 'member'" },
      { query: 'status=ghost', message: "status must be 'active' or 'disabled'" },
    ];
    for (const { query, message } of cases) {
      const response = await harness.fetch(`http://console.test/api/admin/users?${query}`);
      expect(response.status, query).toBe(400);
      const body = (await response.json()) as { error?: { message?: unknown } };
      expect(body.error?.message).toBe(message);
    }
  });

  it('refuses a weak password or a malformed username on the wire as well', async () => {
    await signInBootstrapAdmin();
    const cases = [
      {
        username: 'weak-pass',
        password: 'short1',
        reason: 'password must be at least 8 characters',
      },
      {
        username: 'no-digit',
        password: 'lettersonly',
        reason: 'password must contain at least one digit',
      },
      {
        username: 'ab',
        password: 'Quiet-H4rbour-1',
        reason: 'username must be at least 3 characters',
      },
      {
        username: 'ad min',
        password: 'Quiet-H4rbour-1',
        reason:
          'username may only contain letters, digits, dot, dash and underscore, ' +
          'and must start with a letter or digit',
      },
    ];
    for (const { username, password, reason } of cases) {
      const failure = await captureApiError(createUser({ username, password }));
      expect(failure.status, username).toBe(400);
      expect(failure.message).toBe(reason);
      // The dialog shows operator copy, never the terse API language.
      expect(describeUserRuleMessage(failure.message)).not.toBe(failure.message);
    }
  });

  it('degrades a tampered cursor to the first page instead of failing', async () => {
    await signInBootstrapAdmin();
    await createMemberAccount('cursor-one');
    await createMemberAccount('cursor-two');
    const firstPage = await listUsers({ limit: 2 });

    for (const cursor of ['not-a-cursor', '|', '0|', 'NaN|x', '']) {
      const page = await listUsers({ limit: 2, cursor });
      expect(page.data.map((row) => row.id), cursor).toEqual(
        firstPage.data.map((row) => row.id),
      );
      expect(page.nextCursor, cursor).toBe(firstPage.nextCursor);
    }

    // A well-formed cursor before the first row is an honest empty page.
    await expect(listUsers({ limit: 2, cursor: '0|missing-id' })).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
  });
});

describe('boundary: the panel drives the account lifecycle (panel x auth-api)', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('creates an account the sign-in surface accepts with the role the panel sent', async () => {
    await signInBootstrapAdmin();
    const created = await createUser({
      username: 'ops-two',
      password: 'Quiet-H4rbour-2',
      role: 'admin',
      displayName: 'Ops Two',
    });
    expect(created).toMatchObject({ username: 'ops-two', role: 'admin', displayName: 'Ops Two' });

    // The credentials the create dialog collected now sign in through C-AUTH-WIRE.
    const self = await signInAccount('ops-two', 'Quiet-H4rbour-2');
    expect(self.id).toBe(created.id);
    const state = await fetchAuthState();
    expect(state.user?.role).toBe('admin');
    // ... and the rail the sidebar filters on agrees with that role.
    expect(visibleNavItems(state.user?.role === 'admin').map((item) => item.href)).toContain(
      `${CONSOLE_BASE_PATH}/users`,
    );
    // The new administrator may use the same admin surface the panel reads.
    await expect(
      createUser({ username: 'made-by-peer', password: 'Quiet-H4rbour-3' }),
    ).resolves.toMatchObject({ role: 'member' });
  });

  it('ends a member session the moment the administrator disables the account', async () => {
    await signInBootstrapAdmin();
    const adminCookie = harness.cookie();
    expect(adminCookie).not.toBeNull();

    const member = await createMemberAccount('lapsed-one');
    await signInAccount('lapsed-one', 'Quiet-H4rbour-1');
    const memberCookie = harness.cookie();
    expect(memberCookie).not.toBeNull();
    expect((await fetchAuthState()).user?.id).toBe(member.id);

    harness.setCookie(adminCookie);
    await expect(updateUser(member.id, { status: 'disabled' })).resolves.toMatchObject({
      status: 'disabled',
    });

    // The device cookie the member already holds stops working immediately.
    harness.setCookie(memberCookie);
    expect((await fetchAuthState()).user).toBeNull();
    const refused = await captureApiError(signInAccount('lapsed-one', 'Quiet-H4rbour-1'));
    expect(refused.status).toBe(401);
  });

  it('a password reset ends the account sessions and rotates the password', async () => {
    await signInBootstrapAdmin();
    const adminCookie = harness.cookie();

    const member = await createMemberAccount('reset-me');
    await signInAccount('reset-me', 'Quiet-H4rbour-1');
    const memberCookie = harness.cookie();

    harness.setCookie(adminCookie);
    await expect(resetUserPassword(member.id, 'Quiet-H4rbour-9')).resolves.toBeUndefined();

    harness.setCookie(memberCookie);
    expect((await fetchAuthState()).user).toBeNull();
    expect((await captureApiError(signInAccount('reset-me', 'Quiet-H4rbour-1'))).status).toBe(401);
    // Only the password the administrator typed works now.
    await expect(signInAccount('reset-me', 'Quiet-H4rbour-9')).resolves.toMatchObject({
      id: member.id,
    });
  });

  it('deletes an account: the session dies and the username becomes free again', async () => {
    await signInBootstrapAdmin();
    const adminCookie = harness.cookie();

    const member = await createMemberAccount('gone-soon');
    await signInAccount('gone-soon', 'Quiet-H4rbour-1');
    const memberCookie = harness.cookie();

    harness.setCookie(adminCookie);
    await expect(deleteUser(member.id)).resolves.toBeUndefined();

    harness.setCookie(memberCookie);
    expect((await fetchAuthState()).user).toBeNull();

    harness.setCookie(adminCookie);
    expect((await listUsers({ search: 'gone-soon' })).data).toEqual([]);
    await expect(createMemberAccount('gone-soon')).resolves.toMatchObject({
      username: 'gone-soon',
    });
  });

  it('reflects an inline role or status change through the filter the panel uses', async () => {
    await signInBootstrapAdmin();
    const member = await createMemberAccount('promoted-one');

    expect((await listUsers({ role: 'admin' })).data.map((row) => row.username)).toEqual(['admin']);
    await expect(updateUser(member.id, { role: 'admin' })).resolves.toMatchObject({
      role: 'admin',
    });
    expect((await listUsers({ role: 'admin' })).data.map((row) => row.username).sort()).toEqual([
      'admin',
      'promoted-one',
    ]);

    await updateUser(member.id, { status: 'disabled' });
    expect((await listUsers({ status: 'disabled' })).data.map((row) => row.id)).toEqual([
      member.id,
    ]);
  });

  it('accepts the panel payload for a self display-name edit without a false lockout', async () => {
    const admin = await signInBootstrapAdmin();
    // The edit dialog always submits role + status, so editing your own display name
    // must not trip the self-lockout rule.
    const saved = await updateUser(admin.id, {
      displayName: 'Renamed Operator',
      role: 'admin',
      status: 'active',
    });
    expect(saved).toMatchObject({ displayName: 'Renamed Operator', role: 'admin' });
    const page = await listUsers({ search: 'renamed' });
    expect(page.data.map((row) => row.displayName)).toEqual(['Renamed Operator']);
  });

  it('refuses a member on every endpoint the panel calls, with the console copy', async () => {
    const captcha = solvedCaptcha();
    await register({
      username: 'plain-member',
      password: 'Quiet-H4rbour-1',
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });

    const calls: (() => Promise<unknown>)[] = [
      () => listUsers(),
      () => createUser({ username: 'nobody-here', password: 'Quiet-H4rbour-2' }),
      () => updateSettings({ enabled: false }),
      () => getSettings(),
    ];
    for (const call of calls) {
      const failure = await captureApiError(call());
      expect(failure.status).toBe(403);
      expect(describeApiFailure(failure)).toBe(ADMIN_REQUIRED_MESSAGE);
    }

    // The read-only switch a member sees could not have moved the setting.
    await signInBootstrapAdmin();
    await expect(getSettings()).resolves.toEqual({ enabled: true });
  });

  it('answers 401 for a guest, which is not the same failure as a 403', async () => {
    const failure = await captureApiError(listUsers());
    expect(failure.status).toBe(401);
    expect(isUnauthorized(failure)).toBe(true);
    expect(isForbidden(failure)).toBe(false);
  });
});

describe('boundary (users-admin-ui x auth-api): sign-up obeys the switch the panel writes', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('refuses the next sign-up after the switch closes and accepts it again after it reopens',
    async () => {
      await signInBootstrapAdmin();
      // Exactly the panel's sequence: write, then read the stored value back.
      await expect(updateSettings({ enabled: false })).resolves.toEqual({ enabled: false });
      await expect(getSettings()).resolves.toEqual({ enabled: false });

      const challenge = solvedCaptcha();
      const refused = await captureApiError(
        register({
          username: 'late-comer',
          password: 'Quiet-H4rbour-1',
          challengeId: challenge.challengeId,
          captchaAnswer: challenge.answer,
        }),
      );
      expect(refused.status).toBe(403);
      // The refusal must not have created the account half-way.
      expect((await listUsers({ search: 'late-comer' })).data).toEqual([]);

      // Reopening is enough for the very next attempt: no restart, no cache.
      await expect(updateSettings({ enabled: true })).resolves.toEqual({ enabled: true });
      // The same challenge is still usable: a request that could not succeed is
      // refused *before* it burns the captcha (`register/route.ts` check order).
      const created = await register({
        username: 'late-comer',
        password: 'Quiet-H4rbour-1',
        challengeId: challenge.challengeId,
        captchaAnswer: challenge.answer,
      });
      // Registration only ever mints a member, whatever the panel's role select does.
      expect(created).toMatchObject({ username: 'late-comer', role: 'member' });
    });

  it('reports the stored value to the sign-in dialog through /api/auth/session', async () => {
    await signInBootstrapAdmin();
    await updateSettings({ enabled: false });
    // `AuthProvider.registrationEnabled` comes from this probe, and it is what hides
    // the register tab; a panel write that never reached it would leave a dead tab.
    const closed = await fetchAuthState();
    expect(closed.user?.role).toBe('admin');
    expect(closed.registration.enabled).toBe(false);

    await updateSettings({ enabled: true });
    expect((await fetchAuthState()).registration.enabled).toBe(true);
  });
});
