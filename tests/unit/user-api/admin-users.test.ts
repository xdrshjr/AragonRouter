import { beforeEach, describe, expect, it } from 'vitest';
import * as registerRoute from '@/app/api/auth/register/route';
import * as settingsRoute from '@/app/api/admin/settings/route';
import * as userRoute from '@/app/api/admin/users/[id]/route';
import * as userPasswordRoute from '@/app/api/admin/users/[id]/password/route';
import * as userSessionRoute from '@/app/api/admin/users/[id]/sessions/[sessionId]/route';
import * as usersRoute from '@/app/api/admin/users/route';
import { authenticateSessionToken } from '@/lib/sessions';
import {
  RegistrationClosedError,
  assertRegistrationOpen,
  isRegistrationEnabled,
} from '@/lib/settings';
import type { UserDetailPublic, UserPublic, UserSessionPublic } from '@/lib/types';
import { authenticateUser } from '@/lib/users';
import {
  TEST_ADMIN_PASSWORD,
  TEST_MEMBER_PASSWORD,
  jsonRequest,
  prepareTestEnv,
} from '../test-helpers';
import { registerPayload } from './harness';
import {
  SETTINGS_KEYS,
  USER_PUBLIC_KEYS,
  USER_SESSION_KEYS,
  type AdminMethod,
  type SignedIn,
  type UserListEnvelope,
  callAdmin,
  createAdminAccount,
  createMemberAccount,
  seedUsers,
  signInAdmin,
  signInAs,
  uniqueUsername,
} from './admin-harness';

/**
 * C-USERS-WIRE / C-SETTINGS-WIRE: the five admin route handlers.
 *
 * Every case goes through the exported handler, so the guard (`withAdmin`), the
 * envelope and the store rules are exercised exactly as the console will hit them.
 * The two contracts the rest of the batch depends on are pinned here: the response
 * *shapes* (`{data,nextCursor}`, `UserPublic`, `UserDetailPublic`, `{registration}`)
 * and the status codes the UI keys its behaviour on (401 sign in again, 403 not
 * yours, 400 the message is showable, 404 gone).
 */

interface DataBody<T> {
  data: T;
}

interface ErrorBody {
  error: { message: string };
}

const ADMIN_METHODS: AdminMethod[] = ['GET', 'POST', 'PATCH', 'DELETE'];

beforeEach(() => {
  prepareTestEnv();
});

/** Read the body once and keep both views (the leak checks need the raw text). */
async function bodyOf<T>(response: Response): Promise<{ json: T; text: string }> {
  const text = await response.text();
  return { json: JSON.parse(text) as T, text };
}

async function listUsersPage(
  query: string,
  headers: Record<string, string>,
): Promise<{ response: Response; body: UserListEnvelope; text: string }> {
  const response = await callAdmin(`/api/admin/users${query}`, { headers });
  const { json, text } = await bodyOf<UserListEnvelope>(response);
  return { response, body: json, text };
}

async function readUser(
  path: string,
  headers: Record<string, string>,
): Promise<{ response: Response; json: UserPublic }> {
  const response = await callAdmin(path, { headers });
  const { json } = await bodyOf<DataBody<UserPublic>>(response);
  return { response, json: json.data };
}

async function patchUser(
  userId: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return callAdmin(`/api/admin/users/${userId}`, { method: 'PATCH', body, headers });
}

/** Promote/demote helpers keep the rule tests readable. */
function disableUser(userId: string, headers: Record<string, string>): Promise<Response> {
  return patchUser(userId, { status: 'disabled' }, headers);
}

describe('admin users: guard matrix (C-GUARD)', () => {
  interface GuardCase {
    name: string;
    method: AdminMethod;
    path: string;
    body?: unknown;
  }

  /**
   * One case per method/endpoint pair, each pointing at a fresh resource so the
   * admin leg (which really mutates) is the only leg that changes anything.
   */
  function buildGuardCases(): GuardCase[] {
    const target = createMemberAccount(uniqueUsername('guard-target'));
    const patchTarget = createMemberAccount(uniqueUsername('guard-patch'));
    const deleteTarget = createMemberAccount(uniqueUsername('guard-delete'));
    const resetTarget = createMemberAccount(uniqueUsername('guard-reset'));
    const sessionOwner = createMemberAccount(uniqueUsername('guard-session'));
    const victimDevice = signInAs(sessionOwner.id, 'guard-device');
    return [
      { name: 'GET /users', method: 'GET', path: '/api/admin/users' },
      {
        name: 'POST /users',
        method: 'POST',
        path: '/api/admin/users',
        body: { username: uniqueUsername('guard-created'), password: TEST_MEMBER_PASSWORD },
      },
      { name: 'GET /users/[id]', method: 'GET', path: `/api/admin/users/${target.id}` },
      {
        name: 'PATCH /users/[id]',
        method: 'PATCH',
        path: `/api/admin/users/${patchTarget.id}`,
        body: { displayName: 'Guard Renamed' },
      },
      { name: 'DELETE /users/[id]', method: 'DELETE', path: `/api/admin/users/${deleteTarget.id}` },
      {
        name: 'POST /users/[id]/password',
        method: 'POST',
        path: `/api/admin/users/${resetTarget.id}/password`,
        body: { password: 'Matrix-Secret-Pass9' },
      },
      {
        name: 'DELETE /users/[id]/sessions/[sessionId]',
        method: 'DELETE',
        path: `/api/admin/users/${sessionOwner.id}/sessions/${victimDevice.sessionId}`,
      },
      { name: 'GET /settings', method: 'GET', path: '/api/admin/settings' },
      // Last on purpose: it flips the registration switch globally.
      {
        name: 'PATCH /settings',
        method: 'PATCH',
        path: '/api/admin/settings',
        body: { registration: { enabled: false } },
      },
    ];
  }

  it('answers 401 for a guest and 403 for a member on every endpoint', async () => {
    const cases = buildGuardCases();
    const member: SignedIn = signInAs(createMemberAccount(uniqueUsername('guard-member')).id);

    for (const testCase of cases) {
      const guest = await callAdmin(testCase.path, {
        method: testCase.method,
        body: testCase.body,
      });
      expect(guest.status, `guest ${testCase.name}`).toBe(401);
      expect((await bodyOf<ErrorBody>(guest)).json, `guest ${testCase.name}`).toEqual({
        error: { message: 'unauthorized' },
      });

      const forbidden = await callAdmin(testCase.path, {
        method: testCase.method,
        body: testCase.body,
        headers: member.headers,
      });
      expect(forbidden.status, `member ${testCase.name}`).toBe(403);
      expect((await bodyOf<ErrorBody>(forbidden)).json, `member ${testCase.name}`).toEqual({
        error: { message: 'forbidden' },
      });
    }
  });

  it('lets an admin through on every endpoint (200/201, never 401/403)', async () => {
    const cases = buildGuardCases();
    const admin = signInAdmin();

    for (const testCase of cases) {
      const allowed = await callAdmin(testCase.path, {
        method: testCase.method,
        body: testCase.body,
        headers: admin.headers,
      });
      expect([200, 201], `admin ${testCase.name}`).toContain(allowed.status);
    }
  });

  it('exports exactly the documented HTTP methods per route module', () => {
    const surface: [string, Record<string, unknown>, string[]][] = [
      ['admin/users/route.ts', usersRoute, ['GET', 'POST']],
      ['admin/users/[id]/route.ts', userRoute, ['DELETE', 'GET', 'PATCH']],
      ['admin/users/[id]/password/route.ts', userPasswordRoute, ['POST']],
      ['admin/users/[id]/sessions/[sessionId]/route.ts', userSessionRoute, ['DELETE']],
      ['admin/settings/route.ts', settingsRoute, ['GET', 'PATCH']],
    ];
    for (const [name, module, methods] of surface) {
      const exported = Object.keys(module)
        .filter((key) => ADMIN_METHODS.includes(key as AdminMethod))
        .sort();
      // `runtime`/`dynamic` are the other exports; anything else would be a stray
      // verb the console cannot address.
      expect(exported, name).toEqual(methods);
    }
  });
});

describe('GET /api/admin/users: list (C-USERS-WIRE)', () => {
  it('returns {data, nextCursor} with the UserPublic shape only', async () => {
    const admin = signInAdmin();
    createMemberAccount('list-shape-member');
    const { response, body, text } = await listUsersPage('', admin.headers);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(['data', 'nextCursor']);
    expect(body.nextCursor).toBeNull();
    expect(body.data.map((user) => user.username).sort()).toEqual([
      'admin',
      'list-shape-member',
    ]);
    for (const user of body.data) expect(Object.keys(user).sort()).toEqual(USER_PUBLIC_KEYS);
    expect(text).not.toContain('password');
    expect(text).not.toContain('scrypt$');
  });

  it('filters by search (case-insensitive, literal wildcards), role and status', async () => {
    const admin = signInAdmin();
    createMemberAccount('alice-search');
    createAdminAccount('bob-search');
    seedUsers(1, { prefix: 'dormant', status: 'disabled' });

    const bySearch = await listUsersPage('?search=ALICE', admin.headers);
    expect(bySearch.body.data.map((user) => user.username)).toEqual(['alice-search']);

    const byRole = await listUsersPage('?role=admin', admin.headers);
    expect(byRole.body.data.map((user) => user.username).sort()).toEqual(['admin', 'bob-search']);
    expect(byRole.body.data.every((user) => user.role === 'admin')).toBe(true);

    const byStatus = await listUsersPage('?status=disabled', admin.headers);
    expect(byStatus.body.data.map((user) => user.username)).toEqual(['dormant000']);
    expect(byStatus.body.data[0]?.status).toBe('disabled');

    const combined = await listUsersPage('?role=member&status=active', admin.headers);
    expect(combined.body.data.map((user) => user.username)).toEqual(['alice-search']);

    // `%` is a search term, not a wildcard: escaping is the list's contract.
    const wildcard = await listUsersPage('?search=%25', admin.headers);
    expect(wildcard.body.data).toEqual([]);

    // An empty filter value means "no filter", not "invalid".
    const empty = await listUsersPage('?role=&status=', admin.headers);
    expect(empty.body.data.length).toBe(4);
  });

  it('maps an illegal role or status to 400 instead of an empty page', async () => {
    const admin = signInAdmin();
    for (const query of ['?role=superuser', '?status=suspended', '?role=ADMIN']) {
      const response = await callAdmin(`/api/admin/users${query}`, { headers: admin.headers });
      expect(response.status, query).toBe(400);
      const body = await bodyOf<ErrorBody>(response);
      expect(body.json.error.message.length).toBeGreaterThan(0);
      expect(body.text).not.toContain('password');
    }
  });

  it('clamps limit to 100 and walks the keyset cursor without duplicates', async () => {
    const admin = signInAdmin();
    seedUsers(101, { prefix: 'bulk' });

    const first = await listUsersPage('?limit=5000', admin.headers);
    expect(first.response.status).toBe(200);
    expect(first.body.data).toHaveLength(100);
    expect(first.body.nextCursor).not.toBeNull();

    const cursor = encodeURIComponent(first.body.nextCursor ?? '');
    const second = await listUsersPage(`?limit=5000&cursor=${cursor}`, admin.headers);
    // 101 seeded rows + the bootstrap admin.
    expect(second.body.data).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();

    const ids = new Set([...first.body.data, ...second.body.data].map((user) => user.id));
    expect(ids.size).toBe(102);
  });

  it('treats a malformed cursor and a negative limit as defaults, not errors', async () => {
    const admin = signInAdmin();
    createMemberAccount('cursor-member');
    const garbage = await listUsersPage('?cursor=garbage&limit=-3', admin.headers);
    expect(garbage.response.status).toBe(200);
    expect(garbage.body.data).toHaveLength(2);
    expect(garbage.body.nextCursor).toBeNull();
  });
});

describe('POST /api/admin/users: create (C-USERS-WIRE)', () => {
  it('returns 201 with the UserPublic DTO and stores a real hash', async () => {
    const admin = signInAdmin();
    const response = await callAdmin('/api/admin/users', {
      method: 'POST',
      body: {
        username: 'created-user',
        password: TEST_MEMBER_PASSWORD,
        displayName: '  Created User  ',
      },
      headers: admin.headers,
    });
    expect(response.status).toBe(201);
    const { json, text } = await bodyOf<DataBody<UserPublic>>(response);
    expect(Object.keys(json.data).sort()).toEqual(USER_PUBLIC_KEYS);
    expect(json.data).toMatchObject({
      username: 'created-user',
      displayName: 'Created User',
      role: 'member',
      status: 'active',
      lastLoginAt: null,
    });
    expect(text).not.toContain('password');
    expect(text).not.toContain('scrypt$');
    expect(authenticateUser('created-user', TEST_MEMBER_PASSWORD)).not.toBeNull();
  });

  it('accepts an explicit admin role and rejects an unknown one', async () => {
    const admin = signInAdmin();
    const promoted = await callAdmin('/api/admin/users', {
      method: 'POST',
      body: { username: 'created-admin', password: TEST_MEMBER_PASSWORD, role: 'admin' },
      headers: admin.headers,
    });
    expect(promoted.status).toBe(201);
    expect((await bodyOf<DataBody<UserPublic>>(promoted)).json.data.role).toBe('admin');

    const invalid = await callAdmin('/api/admin/users', {
      method: 'POST',
      body: { username: 'created-root', password: TEST_MEMBER_PASSWORD, role: 'root' },
      headers: admin.headers,
    });
    expect(invalid.status).toBe(400);
    expect((await bodyOf<ErrorBody>(invalid)).json.error.message).toContain('role');
    const listed = await listUsersPage('?search=created-root', admin.headers);
    expect(listed.body.data).toEqual([]);
  });

  it('rejects a duplicate username case-insensitively without writing a row', async () => {
    const admin = signInAdmin();
    createMemberAccount('taken-name');
    const response = await callAdmin('/api/admin/users', {
      method: 'POST',
      body: { username: 'TAKEN-NAME', password: TEST_MEMBER_PASSWORD },
      headers: admin.headers,
    });
    expect(response.status).toBe(400);
    const body = await bodyOf<ErrorBody>(response);
    expect(body.json.error.message).toBe('username is already taken');
    const listed = await listUsersPage('?search=taken-name', admin.headers);
    expect(listed.body.data.map((user) => user.username)).toEqual(['taken-name']);
  });

  it('rejects a weak password, a bad username and a missing password with 400', async () => {
    const admin = signInAdmin();
    const cases: { body: unknown; fragment: string }[] = [
      { body: { username: 'weak-pass', password: 'short' }, fragment: 'at least 8' },
      { body: { username: 'weak-pass', password: 'nodigitshere' }, fragment: 'digit' },
      { body: { username: 'x', password: TEST_MEMBER_PASSWORD }, fragment: 'at least 3' },
      { body: { username: 'has space', password: TEST_MEMBER_PASSWORD }, fragment: 'username' },
      { body: { username: 'no-password' }, fragment: 'password is required' },
      { body: {}, fragment: 'username is required' },
      { body: 'not json', fragment: 'valid JSON' },
    ];
    for (const testCase of cases) {
      const response = await callAdmin('/api/admin/users', {
        method: 'POST',
        body: testCase.body,
        headers: admin.headers,
      });
      expect(response.status, JSON.stringify(testCase.body)).toBe(400);
      const body = await bodyOf<ErrorBody>(response);
      expect(body.json.error.message, JSON.stringify(testCase.body)).toContain(testCase.fragment);
    }
    // Nothing above reached the table.
    const listed = await listUsersPage('', admin.headers);
    expect(listed.body.data.map((user) => user.username)).toEqual(['admin']);
  });
});

describe('GET /api/admin/users/[id]: detail (C-USERS-WIRE)', () => {
  it('returns UserDetailPublic with live sessions and flags the caller session', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('detail-member');
    const device = signInAs(member.id, 'detail-device');

    const response = await callAdmin(`/api/admin/users/${member.id}`, { headers: admin.headers });
    expect(response.status).toBe(200);
    const { json, text } = await bodyOf<DataBody<UserDetailPublic>>(response);
    expect(Object.keys(json.data).sort()).toEqual([...USER_PUBLIC_KEYS, 'sessions'].sort());
    expect(json.data.sessions).toHaveLength(1);
    expect(json.data.sessions[0]).toMatchObject({ id: device.sessionId, current: false });
    expect(Object.keys(json.data.sessions[0] as UserSessionPublic).sort()).toEqual(
      USER_SESSION_KEYS,
    );
    expect(text).not.toContain('password');
    expect(text).not.toContain('scrypt$');
  });

  it('marks the session the administrator is holding as current', async () => {
    const admin = signInAdmin();
    const second = signInAs(admin.userId, 'second-admin-device');
    const response = await callAdmin(`/api/admin/users/${admin.userId}`, {
      headers: admin.headers,
    });
    const { json } = await bodyOf<DataBody<UserDetailPublic>>(response);
    const flagged = json.data.sessions.filter((session) => session.current);
    expect(flagged.map((session) => session.id)).toEqual([admin.sessionId]);
    expect(json.data.sessions.map((session) => session.id)).toContain(second.sessionId);
  });

  it('answers 404 for an unknown id', async () => {
    const admin = signInAdmin();
    const ids = ['missing-user', encodeURIComponent('a b'), encodeURIComponent('../../etc/passwd')];
    for (const id of ids) {
      const response = await callAdmin(`/api/admin/users/${id}`, { headers: admin.headers });
      expect(response.status, id).toBe(404);
      expect((await bodyOf<ErrorBody>(response)).json).toEqual({
        error: { message: 'user not found' },
      });
    }
  });
});

describe('PATCH /api/admin/users/[id]: update (C-USERS-WIRE)', () => {
  it('updates displayName, role and status and echoes UserPublic', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('patch-member');

    const renamed = await patchUser(member.id, { displayName: '  Renamed  ' }, admin.headers);
    expect(renamed.status).toBe(200);
    const renamedBody = await bodyOf<DataBody<UserPublic>>(renamed);
    expect(Object.keys(renamedBody.json.data).sort()).toEqual(USER_PUBLIC_KEYS);
    expect(renamedBody.json.data.displayName).toBe('Renamed');

    const promoted = await patchUser(member.id, { role: 'admin' }, admin.headers);
    expect((await bodyOf<DataBody<UserPublic>>(promoted)).json.data.role).toBe('admin');

    const cleared = await patchUser(member.id, { displayName: null }, admin.headers);
    expect((await bodyOf<DataBody<UserPublic>>(cleared)).json.data.displayName).toBeNull();

    const device = signInAs(member.id, 'patch-device');
    const disabled = await disableUser(member.id, admin.headers);
    expect(disabled.status).toBe(200);
    expect((await bodyOf<DataBody<UserPublic>>(disabled)).json.data.status).toBe('disabled');
    // A disabled account loses its sessions immediately.
    expect(authenticateSessionToken(device.token)).toBeNull();
  });

  it('ignores fields outside the contract (the username is not editable)', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('immutable-name');
    const response = await patchUser(
      member.id,
      { username: 'renamed-by-patch', displayName: 'Still Here', role: 'member' },
      admin.headers,
    );
    expect(response.status).toBe(200);
    const { json } = await bodyOf<DataBody<UserPublic>>(response);
    expect(json.data.username).toBe('immutable-name');
    expect(json.data.displayName).toBe('Still Here');
  });

  it('refuses self-disable and self-demotion with a displayable 400', async () => {
    const admin = signInAdmin();
    // A second active admin keeps the last-admin rule out of the way, so the
    // refusal below is provably the self-lockout rule and not a side effect.
    createAdminAccount('backup-admin');

    const selfDisable = await disableUser(admin.userId, admin.headers);
    expect(selfDisable.status).toBe(400);
    expect((await bodyOf<ErrorBody>(selfDisable)).json.error.message).toContain(
      'cannot disable your own account',
    );

    const selfDemote = await patchUser(admin.userId, { role: 'member' }, admin.headers);
    expect(selfDemote.status).toBe(400);
    expect((await bodyOf<ErrorBody>(selfDemote)).json.error.message).toContain(
      'cannot remove your own admin role',
    );
    // Neither attempt changed the row.
    const still = await readUser(`/api/admin/users/${admin.userId}`, admin.headers);
    expect(still.json).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('refuses to remove the last active admin', async () => {
    const admin = signInAdmin();
    const bye = await patchUser(admin.userId, { status: 'disabled' }, admin.headers);
    expect(bye.status).toBe(400);
    expect((await bodyOf<ErrorBody>(bye)).json.error.message).toContain('active admin');
    expect(authenticateUser('admin', TEST_ADMIN_PASSWORD)).not.toBeNull();
  });

  it('rejects malformed bodies and unknown targets', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('patch-invalid');

    for (const body of ['not json', [], '']) {
      const response = await patchUser(member.id, body, admin.headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ role: 'root' }, { status: 'sleeping' }, { displayName: 42 }]) {
      const response = await patchUser(member.id, body, admin.headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const unknown = await patchUser('missing-user', { displayName: 'x' }, admin.headers);
    expect(unknown.status).toBe(404);
  });

  it('refuses an explicit null role/status instead of rewriting the account', async () => {
    const admin = signInAdmin();
    // A second active admin keeps the last-admin rule out of the way, so the only
    // thing that could make `role: null` land is the store reading null as "default".
    createAdminAccount('null-enum-backup');
    const member = createMemberAccount('null-enum-member');
    const promoted = await patchUser(member.id, { role: 'admin' }, admin.headers);
    expect((await bodyOf<DataBody<UserPublic>>(promoted)).json.data.role).toBe('admin');

    for (const body of [{ role: null }, { status: null }, { role: 7 }, { status: {} }]) {
      const response = await patchUser(member.id, body, admin.headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await bodyOf<ErrorBody>(response)).json.error.message.length).toBeGreaterThan(0);
    }
    const still = await readUser(`/api/admin/users/${member.id}`, admin.headers);
    expect(still.json).toMatchObject({ role: 'admin', status: 'active' });

    // The security-relevant leg: `{"status":null}` must not silently re-activate a
    // disabled account (which would hand the device list back to a revoked user).
    const dormant = createMemberAccount('null-enum-dormant');
    expect((await disableUser(dormant.id, admin.headers)).status).toBe(200);
    const reactivate = await patchUser(dormant.id, { status: null }, admin.headers);
    expect(reactivate.status).toBe(400);
    const dormantNow = await readUser(`/api/admin/users/${dormant.id}`, admin.headers);
    expect(dormantNow.json.status).toBe('disabled');
  });
});

describe('DELETE /api/admin/users/[id]: delete (C-USERS-WIRE)', () => {
  it('answers {data:{ok:true}} and removes the account with its sessions', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('delete-member');
    const device = signInAs(member.id, 'delete-device');

    const response = await callAdmin(`/api/admin/users/${member.id}`, {
      method: 'DELETE',
      headers: admin.headers,
    });
    expect(response.status).toBe(200);
    const body = await bodyOf<unknown>(response);
    expect(body.json).toEqual({ data: { ok: true } });
    expect(authenticateSessionToken(device.token)).toBeNull();
    expect((await callAdmin(`/api/admin/users/${member.id}`, { headers: admin.headers })).status)
      .toBe(404);
  });

  it('refuses self-deletion with a displayable 400 and keeps the account', async () => {
    const admin = signInAdmin();
    const response = await callAdmin(`/api/admin/users/${admin.userId}`, {
      method: 'DELETE',
      headers: admin.headers,
    });
    expect(response.status).toBe(400);
    expect((await bodyOf<ErrorBody>(response)).json.error.message).toContain(
      'cannot delete your own account',
    );
    const still = await callAdmin(`/api/admin/users/${admin.userId}`, { headers: admin.headers });
    expect(still.status).toBe(200);
  });

  it('answers 404 for an unknown id and leaks nothing else', async () => {
    const admin = signInAdmin();
    const response = await callAdmin('/api/admin/users/missing-user', {
      method: 'DELETE',
      headers: admin.headers,
    });
    expect(response.status).toBe(404);
    const body = await bodyOf<ErrorBody>(response);
    expect(body.json).toEqual({ error: { message: 'user not found' } });
    expect(body.text).not.toContain('password');
  });
});

describe('POST /api/admin/users/[id]/password: reset (C-USERS-WIRE)', () => {
  it('replaces the password and revokes every session of that user', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('reset-member');
    const firstDevice = signInAs(member.id, 'reset-device-1');
    const secondDevice = signInAs(member.id, 'reset-device-2');

    const response = await callAdmin(`/api/admin/users/${member.id}/password`, {
      method: 'POST',
      body: { password: 'Brand-New-Pass9' },
      headers: admin.headers,
    });
    expect(response.status).toBe(200);
    expect((await bodyOf<unknown>(response)).json).toEqual({ data: { ok: true } });
    expect(authenticateSessionToken(firstDevice.token)).toBeNull();
    expect(authenticateSessionToken(secondDevice.token)).toBeNull();
    expect(authenticateUser('reset-member', 'Brand-New-Pass9')).not.toBeNull();
    expect(authenticateUser('reset-member', TEST_MEMBER_PASSWORD)).toBeNull();
  });

  it('keeps the acting session alive when an admin rotates their own password', async () => {
    const admin = signInAdmin();
    const otherDevice = signInAs(admin.userId, 'admin-tablet');
    const response = await callAdmin(`/api/admin/users/${admin.userId}/password`, {
      method: 'POST',
      body: { password: 'Rotated-Secret-9' },
      headers: admin.headers,
    });
    expect(response.status).toBe(200);
    expect(authenticateUser('admin', 'Rotated-Secret-9')).not.toBeNull();
    expect(authenticateSessionToken(admin.token)).not.toBeNull();
    expect(authenticateSessionToken(otherDevice.token)).toBeNull();
    // The cookie still works on the protected route that minted it.
    expect((await callAdmin('/api/admin/users', { headers: admin.headers })).status).toBe(200);
  });

  it('rejects a weak password, a missing password and an unknown user', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('reset-invalid');

    for (const body of [{ password: 'short' }, { password: 'nodigitshere' }, {}]) {
      const response = await callAdmin(`/api/admin/users/${member.id}/password`, {
        method: 'POST',
        body,
        headers: admin.headers,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // The failed attempts changed nothing.
    expect(authenticateUser('reset-invalid', TEST_MEMBER_PASSWORD)).not.toBeNull();

    const unknown = await callAdmin('/api/admin/users/missing-user/password', {
      method: 'POST',
      body: { password: 'Brand-New-Pass9' },
      headers: admin.headers,
    });
    expect(unknown.status).toBe(404);
  });
});

describe('DELETE /api/admin/users/[id]/sessions/[sessionId]: revoke (C-USERS-WIRE)', () => {
  it('revokes exactly one session and is idempotent', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('session-member');
    const doomed = signInAs(member.id, 'doomed-device');
    const survivor = signInAs(member.id, 'surviving-device');

    const path = `/api/admin/users/${member.id}/sessions/${doomed.sessionId}`;
    const response = await callAdmin(path, { method: 'DELETE', headers: admin.headers });
    expect(response.status).toBe(200);
    expect((await bodyOf<unknown>(response)).json).toEqual({ data: { ok: true } });
    expect(authenticateSessionToken(doomed.token)).toBeNull();
    expect(authenticateSessionToken(survivor.token)).not.toBeNull();

    const again = await callAdmin(path, { method: 'DELETE', headers: admin.headers });
    expect(again.status).toBe(200);
    expect((await bodyOf<unknown>(again)).json).toEqual({ data: { ok: true } });
  });

  it('answers 404 identically for a foreign session and an unknown one', async () => {
    const admin = signInAdmin();
    const owner = createMemberAccount('session-owner');
    const stranger = createMemberAccount('session-stranger');
    const strangerDevice = signInAs(stranger.id, 'stranger-device');

    const foreign = await callAdmin(
      `/api/admin/users/${owner.id}/sessions/${strangerDevice.sessionId}`,
      { method: 'DELETE', headers: admin.headers },
    );
    expect(foreign.status).toBe(404);
    const foreignBody = await bodyOf<ErrorBody>(foreign);
    expect(foreignBody.json).toEqual({ error: { message: 'session not found' } });
    // The cross-user attempt touched nothing.
    expect(authenticateSessionToken(strangerDevice.token)).not.toBeNull();

    const unknown = await callAdmin(
      `/api/admin/users/${owner.id}/sessions/${'0'.repeat(32)}`,
      { method: 'DELETE', headers: admin.headers },
    );
    expect(unknown.status).toBe(404);
    expect((await bodyOf<ErrorBody>(unknown)).json).toEqual(foreignBody.json);

    const unknownUser = await callAdmin(
      `/api/admin/users/missing-user/sessions/${strangerDevice.sessionId}`,
      { method: 'DELETE', headers: admin.headers },
    );
    expect(unknownUser.status).toBe(404);
    expect((await bodyOf<ErrorBody>(unknownUser)).json).toEqual({
      error: { message: 'user not found' },
    });
  });
});

describe('GET/PATCH /api/admin/settings: registration switch (C-SETTINGS-WIRE)', () => {
  it('reports the default (open) state', async () => {
    const admin = signInAdmin();
    const response = await callAdmin('/api/admin/settings', { headers: admin.headers });
    expect(response.status).toBe(200);
    const { json } = await bodyOf<DataBody<{ registration: { enabled: boolean } }>>(response);
    expect(Object.keys(json).sort()).toEqual(['data']);
    expect(Object.keys(json.data).sort()).toEqual(SETTINGS_KEYS);
    expect(json.data.registration).toEqual({ enabled: true });
  });

  it('persists the switch and applies it to the very next registration attempt', async () => {
    const admin = signInAdmin();
    const closed = await callAdmin('/api/admin/settings', {
      method: 'PATCH',
      body: { registration: { enabled: false } },
      headers: admin.headers,
    });
    expect(closed.status).toBe(200);
    const closedBody = await bodyOf<DataBody<{ registration: { enabled: boolean } }>>(closed);
    expect(closedBody.json.data.registration).toEqual({ enabled: false });
    expect(isRegistrationEnabled()).toBe(false);
    // The exact gate `/api/auth/register` calls: closed => refuses right away.
    expect(() => assertRegistrationOpen()).toThrow(RegistrationClosedError);

    const reopened = await callAdmin('/api/admin/settings', {
      method: 'PATCH',
      body: { registration: { enabled: true } },
      headers: admin.headers,
    });
    expect(reopened.status).toBe(200);
    expect(isRegistrationEnabled()).toBe(true);
    expect(() => assertRegistrationOpen()).not.toThrow();

    const readBack = await callAdmin('/api/admin/settings', { headers: admin.headers });
    expect((await bodyOf<DataBody<{ registration: { enabled: boolean } }>>(readBack)).json).toEqual(
      { data: { registration: { enabled: true } } },
    );
  });

  it('rejects every malformed body with 400 and writes nothing', async () => {
    const admin = signInAdmin();
    const bodies: unknown[] = [
      {},
      { registration: { enabled: 'yes' } },
      { registration: { enabled: 1 } },
      { registration: true },
      { registration: [] },
      { registration: null },
      { enabled: false },
      'not json',
      '',
    ];
    for (const body of bodies) {
      const response = await callAdmin('/api/admin/settings', {
        method: 'PATCH',
        body,
        headers: admin.headers,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await bodyOf<ErrorBody>(response)).json.error.message.length).toBeGreaterThan(0);
    }
    expect(isRegistrationEnabled()).toBe(true);
  });
});

describe('C-SETTINGS-WIRE: the switch reaches POST /api/auth/register', () => {
  /**
   * Producer/consumer check across work packages: the write goes through *this*
   * PATCH handler, the read goes through the auth work package's real register
   * handler. Nothing is wired directly in between, so a cached or duplicated
   * registration flag would fail here.
   */
  function setSwitch(admin: SignedIn, enabled: boolean): Promise<Response> {
    return callAdmin('/api/admin/settings', {
      method: 'PATCH',
      body: { registration: { enabled } },
      headers: admin.headers,
    });
  }

  function signUp(username: string): Promise<Response> {
    return registerRoute.POST(
      jsonRequest('http://localhost/api/auth/register', {
        body: registerPayload({ username }),
      }),
    );
  }

  it('closes and reopens registration for the very next sign-up', async () => {
    const admin = signInAdmin();

    expect((await setSwitch(admin, false)).status).toBe(200);
    const refused = await signUp('switch-closed-member');
    expect(refused.status).toBe(403);
    expect((await bodyOf<ErrorBody>(refused)).json).toEqual({ error: { message: 'forbidden' } });
    expect(authenticateUser('switch-closed-member', TEST_MEMBER_PASSWORD)).toBeNull();

    expect((await setSwitch(admin, true)).status).toBe(200);
    const allowed = await signUp('switch-open-member');
    expect(allowed.status).toBe(201);
    expect(authenticateUser('switch-open-member', TEST_MEMBER_PASSWORD)).not.toBeNull();

    // The account the console would show next: the new member is in the list.
    const listed = await listUsersPage('?search=switch-open', admin.headers);
    expect(listed.body.data.map((user) => user.username)).toEqual(['switch-open-member']);
  });
});
