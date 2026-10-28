/**
 * Keyset pagination under concurrent writes, plus the retry shapes the panel can
 * actually produce (WP users-admin-ui, acceptance 2).
 *
 * A page requested twice, a create submitted twice and a delete repeated are all
 * reachable through a double click or a dropped response; each has to leave the server
 * consistent and leave the operator with copy they can act on. The reducer is driven
 * with the real cursor the API hands out, so a regression in either half shows up as a
 * missing or repeated row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  buildUsersQuery,
  createUser,
  deleteUser,
  fetchAuthState,
  getSettings,
  listUsers,
  login,
  updateSettings,
  updateUser,
} from '@/components/console/api';
import type { UserPublic } from '@/components/console/types';
import {
  USER_PAGE_SIZE,
  describeUserActionFailure,
  mergeUserPages,
} from '@/components/console/users/user-copy';
import {
  INITIAL_USERS_LIST_STATE,
  reduceUsersList,
} from '@/components/console/users/users-list-state';
import {
  buildUpdateUserPayload,
  describeUserRuleMessage,
} from '@/components/console/validation';
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

describe('keyset pagination and concurrent writes (acceptance 2)', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('never repeats or drops a row when an account is created between two pages', async () => {
    await signInBootstrapAdmin();
    for (let index = 0; index < USER_PAGE_SIZE + 1; index += 1) {
      await createMemberAccount(`bulk-${index}`);
    }

    const firstPage = await listUsers({ limit: USER_PAGE_SIZE });
    expect(firstPage.data).toHaveLength(USER_PAGE_SIZE);

    // "Load more" happens later: an administrator creates an account meanwhile.
    const late = await createMemberAccount('late-arrival');
    const secondPage = await listUsers({ limit: USER_PAGE_SIZE, cursor: firstPage.nextCursor });

    const firstIds = new Set(firstPage.data.map((row) => row.id));
    expect(secondPage.data.some((row) => firstIds.has(row.id))).toBe(false);
    // The newcomer is newer than the cursor, so it belongs to the next refresh,
    // not to the page that is being appended.
    expect(secondPage.data.some((row) => row.id === late.id)).toBe(false);

    const merged = mergeUserPages(firstPage.data, secondPage.data);
    expect(merged).toHaveLength(USER_PAGE_SIZE + 2);
    expect(new Set(merged.map((row) => row.id)).size).toBe(merged.length);

    const refreshed = await listUsers({ limit: USER_PAGE_SIZE });
    expect(refreshed.data[0]?.id).toBe(late.id);
  });

  it('breaks a created_at tie by id, so no sibling row is skipped', async () => {
    await signInBootstrapAdmin();
    // Five accounts in the same millisecond: the cursor can only separate them by id.
    vi.useFakeTimers({ now: new Date('2025-06-01T00:00:00.000Z'), toFake: ['Date'] });
    try {
      for (let index = 0; index < 5; index += 1) {
        await createMemberAccount(`tie-${index}`);
      }
    } finally {
      vi.useRealTimers();
    }

    const firstPage = await listUsers({ limit: 3 });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listUsers({ limit: 3, cursor: firstPage.nextCursor });
    expect(secondPage.nextCursor).toBeNull();

    const merged = mergeUserPages(firstPage.data, secondPage.data);
    expect(merged).toHaveLength(6); // five tied accounts + the bootstrap admin
    expect(new Set(merged.map((row) => row.id)).size).toBe(6);
  });
});

describe('races and idempotency of the actions the panel offers', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('creates exactly one account when the create dialog is submitted twice at once', async () => {
    await signInBootstrapAdmin();
    const input = { username: 'double-submit', password: 'Quiet-H4rbour-1' };
    const settled = await Promise.allSettled([createUser(input), createUser(input)]);

    const created = settled.filter((entry) => entry.status === 'fulfilled');
    const refused = settled.filter((entry) => entry.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const reason = refused.map((entry) => (entry as PromiseRejectedResult).reason)[0];
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).status).toBe(400);
    // The loser sees the same copy the create dialog renders, never a 500.
    expect(describeUserActionFailure(reason as ApiError)).toBe(
      'That username is already taken. Pick another one.',
    );
    expect((await listUsers({ search: 'double-submit' })).data).toHaveLength(1);
  });

  it('repeats the same page for the same cursor, so a double "Load more" skips nothing',
    async () => {
      await signInBootstrapAdmin();
      await createMemberAccount('repeat-one');
      await createMemberAccount('repeat-two');
      await createMemberAccount('repeat-three');

      const firstPage = await listUsers({ limit: 2 });
      expect(firstPage.nextCursor).not.toBeNull();

      // A double click or a retry sends the cursor already on screen twice.
      const [attemptOne, attemptTwo] = await Promise.all([
        listUsers({ limit: 2, cursor: firstPage.nextCursor }),
        listUsers({ limit: 2, cursor: firstPage.nextCursor }),
      ]);
      expect(attemptOne).toEqual(attemptTwo);

      const both = mergeUserPages(mergeUserPages(firstPage.data, attemptOne.data), attemptTwo.data);
      expect(both).toHaveLength(4); // the bootstrap admin plus three members
      expect(new Set(both.map((row) => row.id)).size).toBe(4);
      expect(attemptOne.nextCursor).toBeNull();
    });

  it('answers a second delete with the copy the panel shows, and keeps the row gone',
    async () => {
      await signInBootstrapAdmin();
      const member = await createMemberAccount('delete-twice');

      await expect(deleteUser(member.id)).resolves.toBeUndefined();
      const refused = await captureApiError(deleteUser(member.id));
      expect(refused.status).toBe(404);
      expect(describeUserActionFailure(refused)).toBe(
        'That account no longer exists. Refresh the list and try again.',
      );
      expect((await listUsers({ search: 'delete-twice' })).data).toEqual([]);
    });

  it('repeats the same cursor, limit and filters when a "Load more" is retried', async () => {
    await signInBootstrapAdmin();
    await createMemberAccount('retry-one');
    await createMemberAccount('retry-two');
    const newest = await createMemberAccount('retry-three');

    // The panel builds its query from one frozen filter object (`useMemo`), so a
    // retried page is byte-for-byte the request that failed.
    expect(buildUsersQuery({ limit: 2, search: '', role: 'member', status: 'active' })).toBe(
      '?limit=2&role=member&status=active',
    );
    const page = await listUsers({ limit: 2, search: '', role: 'member', status: 'active' });
    expect(page.data[0]?.id).toBe(newest.id); // newest first, like the table header says
    const retried = await listUsers({ limit: 2, search: '', role: 'member', status: 'active' });
    expect(retried).toEqual(page);

    // The retried page is the one the cursor selects, not the first page again.
    expect(page.nextCursor).not.toBeNull();
    const second = await listUsers({
      limit: 2,
      cursor: page.nextCursor,
      search: '',
      role: 'member',
      status: 'active',
    });
    expect(second.data.map((row) => row.username)).toEqual(['retry-one']);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps the switch consistent when the same value is written again and again',
    async () => {
      await signInBootstrapAdmin();
      const results = await Promise.all([
        updateSettings({ enabled: false }),
        updateSettings({ enabled: false }),
        updateSettings({ enabled: false }),
      ]);
      expect(results.map((result) => result.enabled)).toEqual([false, false, false]);
      await expect(getSettings()).resolves.toEqual({ enabled: false });
      expect((await fetchAuthState()).registration.enabled).toBe(false);
    });
});

describe('sensitive data: no account endpoint hands a secret to the console', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('never sends a password hash, a session token or a stored secret', async () => {
    await signInBootstrapAdmin();
    const member = await createMemberAccount('secret-free', 'Secret Free');

    const calls: { method: string; path: string; body?: string }[] = [
      { method: 'GET', path: '/api/admin/users' },
      { method: 'GET', path: `/api/admin/users/${member.id}` },
      {
        method: 'PATCH',
        path: `/api/admin/users/${member.id}`,
        body: JSON.stringify({ displayName: 'Renamed', role: 'member', status: 'active' }),
      },
      {
        method: 'POST',
        path: '/api/admin/users',
        body: JSON.stringify({ username: 'another-one', password: 'Quiet-H4rbour-2' }),
      },
      {
        method: 'POST',
        path: `/api/admin/users/${member.id}/password`,
        body: JSON.stringify({ password: 'Quiet-H4rbour-3' }),
      },
      { method: 'GET', path: '/api/admin/settings' },
    ];

    for (const call of calls) {
      const response = await harness.fetch(`http://console.test${call.path}`, {
        method: call.method,
        headers: { 'content-type': 'application/json' },
        body: call.body,
      });
      const label = `${call.method} ${call.path}`;
      expect(response.status, label).toBeLessThan(400);
      const text = await response.text();
      // A scrypt hash is the one string that must never leave the server.
      expect(text, `${label} leaked a password hash`).not.toMatch(/scrypt/i);
      // No DTO field may even be named after a secret.
      expect(text, `${label} exposes a secret field`).not.toMatch(
        /"(password|passwordHash|password_hash|token|tokenHash|secret)[^"]*"\s*:/i,
      );
      // The password the administrator typed is never echoed back either.
      expect(text, `${label} echoed the password`).not.toContain('Quiet-H4rbour-3');
    }
  });
});

describe('boundary: the list state machine consumes the real keyset pages', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('rebuilds the whole account list by walking the cursor it was handed', async () => {
    await signInBootstrapAdmin();
    for (const username of ['page-a', 'page-b', 'page-c']) {
      await createMemberAccount(username);
    }

    const firstPage = await listUsers({ limit: 2 });
    let state = reduceUsersList(
      reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
      { type: 'page-loaded', mode: 'replace', page: firstPage },
    );

    let pages = 1;
    while (pages < 10) {
      const cursor = state.nextCursor;
      if (cursor === null) break;
      state = reduceUsersList(state, { type: 'load-started', mode: 'append' });
      const page = await listUsers({ limit: 2, cursor });
      state = reduceUsersList(state, { type: 'page-loaded', mode: 'append', page });
      pages += 1;
    }

    const everything = await listUsers({ limit: 100 });
    expect(everything.nextCursor).toBeNull();
    expect(state.rows.map((row) => row.id)).toEqual(everything.data.map((row) => row.id));
    expect(state.rows).toHaveLength(4); // the bootstrap admin plus three members
    expect(new Set(state.rows.map((row) => row.id)).size).toBe(4);
    expect(pages).toBeGreaterThan(1); // the loop really followed at least one cursor
  });
});

describe('boundary: the edit dialog payload is the one the store accepts', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('clears a display name with the null the dialog sends, keeping role and status',
    async () => {
      await signInBootstrapAdmin();
      const member = await createMemberAccount('editable-one', 'Editable One');
      expect(member.displayName).toBe('Editable One');

      const payload = buildUpdateUserPayload({
        displayName: '   ',
        role: 'member',
        status: 'active',
      });
      expect(payload).toEqual({ displayName: null, role: 'member', status: 'active' });

      const saved = await updateUser(member.id, payload);
      expect(saved.displayName).toBeNull();
      expect(saved).toMatchObject({ role: 'member', status: 'active' });
      // The table renders an em dash for a null display name: the list must report null.
      expect((await listUsers({ search: 'editable-one' })).data[0]?.displayName).toBeNull();
    });

  it('refuses a null role or status with the copy the dialog renders', async () => {
    await signInBootstrapAdmin();
    const member = await createMemberAccount('null-field');

    const refusedRole = await captureApiError(
      updateUser(member.id, { role: null as unknown as 'member' }),
    );
    expect(refusedRole.status).toBe(400);
    expect(describeUserRuleMessage(refusedRole.message)).toBe("Choose 'admin' or 'member'.");

    const refusedStatus = await captureApiError(
      updateUser(member.id, { status: null as unknown as 'active' }),
    );
    expect(refusedStatus.status).toBe(400);
    expect(describeUserRuleMessage(refusedStatus.message)).toBe("Choose 'active' or 'disabled'.");

    // A refused partial update must not have rewritten the row behind the operator.
    expect((await listUsers({ search: 'null-field' })).data[0]).toMatchObject({
      role: 'member',
      status: 'active',
    });
  });
});
