import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '@/lib/env';
import { execute, queryAll, queryOne } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  DEFAULT_USER_LIMIT,
  MAX_USER_LIMIT,
  UserNotFoundError,
  UserRuleError,
  UserValidationError,
  authenticateUser,
  countActiveAdmins,
  createUser,
  deleteUser,
  ensureBootstrapAdmin,
  findUserByUsername,
  getUserById,
  listUsers,
  parseUserCursor,
  parseUserLimit,
  setUserPassword,
  updateUser,
  validateUsername,
} from '@/lib/users';
import type { UserPublic } from '@/lib/types';
import { TEST_ADMIN_PASSWORD, TEST_MEMBER_PASSWORD, prepareTestEnv } from '../test-helpers';

/**
 * C-USER-STORE: bootstrap admin, CRUD, keyset listing and the account rules.
 *
 * The rules under test are the ones that keep an instance usable:
 *  - the last active admin cannot be deleted, disabled or demoted;
 *  - nobody can disable or delete themselves;
 *  - a disabled account cannot authenticate and loses its sessions.
 */

const NOW = 1_700_000_000_000;

beforeEach(() => {
  prepareTestEnv();
});

function makeUser(username: string, overrides: Record<string, unknown> = {}): UserPublic {
  return createUser({
    username,
    password: TEST_MEMBER_PASSWORD,
    displayName: `${username} display`,
    ...overrides,
  });
}

describe('users: bootstrap admin', () => {
  it('creates username=admin with the admin role from ADMIN_PASSWORD', () => {
    const admin = ensureBootstrapAdmin(NOW);
    expect(admin.username).toBe('admin');
    expect(admin.role).toBe('admin');
    expect(admin.created).toBe(true);
    expect(getUserById(admin.id)?.username).toBe('admin');
    expect(countActiveAdmins()).toBe(1);
    expect(authenticateUser('admin', TEST_ADMIN_PASSWORD, NOW)).not.toBeNull();
  });

  it('is idempotent and never re-hashes an existing admin', () => {
    const first = ensureBootstrapAdmin(NOW);
    const stored = queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ?',
      [first.id],
    );
    const second = ensureBootstrapAdmin(NOW + 1000);
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(
      queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [
        first.id,
      ])?.password_hash,
    ).toBe(stored?.password_hash);
    expect(queryAll('SELECT id FROM users')).toHaveLength(1);
  });

  it('fails loudly when ADMIN_PASSWORD is not configured', () => {
    delete process.env.ADMIN_PASSWORD;
    try {
      expect(() => ensureBootstrapAdmin(NOW)).toThrow(ConfigurationError);
      expect(queryAll('SELECT id FROM users')).toHaveLength(0);
    } finally {
      process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    }
  });

  it('refuses to bootstrap over an existing non-admin "admin" row', () => {
    makeUser('admin');
    // The contract promises `role: 'admin'`; neither promoting the row silently nor
    // answering with the real (member) role is honest, so this fails closed.
    expect(() => ensureBootstrapAdmin(NOW)).toThrow(UserRuleError);
    expect(countActiveAdmins()).toBe(0);
  });

  it('refuses to bootstrap while the existing admin row is disabled', () => {
    const admin = ensureBootstrapAdmin(NOW);
    createUser({
      username: 'bootstrap-controller',
      password: 'Str0ng-Passphrase-2',
      role: 'admin',
    });
    updateUser(admin.id, { status: 'disabled' }, NOW, { actorId: 'bootstrap-controller' });
    expect(() => ensureBootstrapAdmin(NOW)).toThrow(UserRuleError);
  });
});

describe('users: creation and validation', () => {
  it('creates a member public DTO with ISO timestamps and no hash', () => {
    const user = makeUser('alice');
    expect(user.username).toBe('alice');
    expect(user.role).toBe('member');
    expect(user.status).toBe('active');
    expect(user.displayName).toBe('alice display');
    expect(user.createdAt).toBe(new Date(Date.parse(user.createdAt)).toISOString());
    expect(user.updatedAt).toBe(new Date(Date.parse(user.updatedAt)).toISOString());
    expect(user.lastLoginAt).toBeNull();
    expect(Object.keys(user).sort()).toEqual(
      ['createdAt', 'displayName', 'id', 'lastLoginAt', 'role', 'status', 'updatedAt', 'username'].sort(),
    );
    expect(JSON.stringify(user)).not.toMatch(/scrypt\$|password/i);
  });

  it('honours an explicit role and an empty display name', () => {
    const admin = createUser({
      username: 'second-admin',
      password: 'Str0ng-Passphrase-1',
      role: 'admin',
      displayName: '   ',
    });
    expect(admin.role).toBe('admin');
    expect(admin.displayName).toBeNull();
    expect(countActiveAdmins()).toBe(1);
  });

  it('rejects invalid usernames, weak passwords, bad roles and duplicates', () => {
    expect(() => createUser({ username: 'ab', password: TEST_MEMBER_PASSWORD })).toThrow(
      UserValidationError,
    );
    expect(() => createUser({ username: 'with space', password: TEST_MEMBER_PASSWORD })).toThrow(
      /may only contain/,
    );
    expect(() => createUser({ username: 'weakling', password: 'short' })).toThrow(/at least 8/);
    expect(() => createUser({ username: 'letters', password: 'onlylettershere' })).toThrow(
      /digit/,
    );
    expect(() => createUser({ username: 'digits', password: '1234567890' })).toThrow(/letter/);
    expect(() =>
      createUser({ username: 'carol', password: 'carol-is-my-name-1' }),
    ).toThrow(/username/);
    expect(() =>
      createUser({ username: 'roled', password: TEST_MEMBER_PASSWORD, role: 'owner' }),
    ).toThrow(/role/);
    expect(() =>
      createUser({
        username: 'longname',
        password: TEST_MEMBER_PASSWORD,
        displayName: 'x'.repeat(65),
      }),
    ).toThrow(/at most 64/);
  });

  it('treats usernames as case-insensitively unique but preserves the given casing', () => {
    const user = makeUser('Alice');
    expect(user.username).toBe('Alice');
    expect(findUserByUsername('alice')?.id).toBe(user.id);
    expect(findUserByUsername('ALICE')?.id).toBe(user.id);
    expect(() => makeUser('aLiCe')).toThrow(/already taken/);
  });

  it('returns null / false for unknown ids instead of throwing', () => {
    expect(getUserById('missing')).toBeNull();
    expect(getUserById(undefined)).toBeNull();
    expect(findUserByUsername('missing')).toBeNull();
    expect(findUserByUsername(null)).toBeNull();
  });
});

describe('users: authentication', () => {
  it('authenticates an active member and records last_login_at', () => {
    const user = makeUser('bob');
    const authenticated = authenticateUser('bob', TEST_MEMBER_PASSWORD, NOW);
    expect(authenticated?.id).toBe(user.id);
    expect(authenticated?.lastLoginAt).toBe(new Date(NOW).toISOString());
    expect(getUserById(user.id)?.lastLoginAt).toBe(new Date(NOW).toISOString());
  });

  it('accepts the username case-insensitively', () => {
    makeUser('bob');
    expect(authenticateUser('BOB', TEST_MEMBER_PASSWORD, NOW)).not.toBeNull();
  });

  it('returns null for a wrong password, an unknown user or a disabled account', () => {
    const user = makeUser('carol');
    expect(authenticateUser('carol', 'wrong-password-1', NOW)).toBeNull();
    expect(authenticateUser('nobody', TEST_MEMBER_PASSWORD, NOW)).toBeNull();
    expect(authenticateUser('carol', '', NOW)).toBeNull();

    execute("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(authenticateUser('carol', TEST_MEMBER_PASSWORD, NOW)).toBeNull();
  });

  it('does not record a login for a failed attempt', () => {
    const user = makeUser('dave');
    authenticateUser('dave', 'nope-1-nope', NOW);
    expect(getUserById(user.id)?.lastLoginAt).toBeNull();
  });
});

describe('users: listing (keyset pagination)', () => {
  it('lists newest first and paginates with the `${created_at}|${id}` cursor', () => {
    for (let index = 0; index < 5; index += 1) {
      createUser(
        { username: `page-user-${index}`, password: TEST_MEMBER_PASSWORD },
        NOW + index * 1000,
      );
    }
    const first = listUsers({ limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.data[0]?.username).toBe('page-user-4');
    // The cursor points at the last row of the page, not past it.
    expect(first.nextCursor).toBe(`${NOW + 3000}|${first.data[1]?.id}`);
    expect(parseUserCursor(first.nextCursor)).toEqual({
      createdAt: NOW + 3000,
      id: first.data[1]?.id,
    });

    const second = listUsers({ limit: 2, cursor: first.nextCursor });
    expect(second.data.map((user) => user.username)).toEqual(['page-user-2', 'page-user-1']);
    const third = listUsers({ limit: 2, cursor: second.nextCursor });
    expect(third.data.map((user) => user.username)).toEqual(['page-user-0']);
    expect(third.nextCursor).toBeNull();
  });

  it('searches usernames and display names case-insensitively', () => {
    makeUser('Searchable');
    createUser({ username: 'other', password: TEST_MEMBER_PASSWORD, displayName: 'Searchable Person' });
    createUser({ username: 'unrelated', password: TEST_MEMBER_PASSWORD, displayName: null });

    expect(listUsers({ search: 'searchable' }).data).toHaveLength(2);
    expect(listUsers({ search: 'OTHER' }).data.map((user) => user.username)).toEqual(['other']);
    expect(listUsers({ search: 'nothing-matches' }).data).toHaveLength(0);
    // `%` is a literal here, not a wildcard.
    expect(listUsers({ search: '%' }).data).toHaveLength(0);
  });

  it('filters by role and status', () => {
    ensureBootstrapAdmin(NOW);
    const member = makeUser('filtered-member');
    createUser({ username: 'filtered-admin', password: 'Quiet-Secr3t-Value', role: 'admin' });
    execute("UPDATE users SET status = 'disabled' WHERE id = ?", [member.id]);

    expect(listUsers({ role: 'admin' }).data).toHaveLength(2);
    expect(listUsers({ status: 'disabled' }).data.map((user) => user.username)).toEqual([
      'filtered-member',
    ]);
    expect(listUsers({ role: 'member', status: 'active' }).data).toHaveLength(0);
  });

  it('rejects an unknown role or status filter instead of returning a silent empty page', () => {
    makeUser('filter-guard');

    expect(() => listUsers({ role: 'owner' })).toThrow(UserValidationError);
    expect(() => listUsers({ status: 'pending' })).toThrow(UserValidationError);
    // An empty query-string value means "no filter", not "an unknown role".
    expect(listUsers({ role: '', status: '' }).data).toHaveLength(1);
  });

  it('clamps the limit to the documented range', () => {
    expect(parseUserLimit(undefined)).toBe(DEFAULT_USER_LIMIT);
    expect(parseUserLimit('7')).toBe(7);
    expect(parseUserLimit('0')).toBe(DEFAULT_USER_LIMIT);
    expect(parseUserLimit('-5')).toBe(DEFAULT_USER_LIMIT);
    expect(parseUserLimit('9999')).toBe(MAX_USER_LIMIT);
    expect(parseUserLimit('abc')).toBe(DEFAULT_USER_LIMIT);
  });

  it('ignores a malformed cursor instead of failing', () => {
    makeUser('cursor-a');
    expect(parseUserCursor('garbage')).toBeNull();
    expect(parseUserCursor('')).toBeNull();
    expect(parseUserCursor(null)).toBeNull();
    expect(listUsers({ cursor: 'garbage' }).data).toHaveLength(1);
  });
});

describe('users: updates and account rules', () => {
  it('updates display name, role and status', () => {
    const user = makeUser('updatable');
    const renamed = updateUser(user.id, { displayName: 'New Name' }, NOW + 1000);
    expect(renamed.displayName).toBe('New Name');
    expect(renamed.updatedAt).toBe(new Date(NOW + 1000).toISOString());

    // A second admin must exist before this user may be demoted or disabled.
    const bootstrap = ensureBootstrapAdmin(NOW);
    const promoted = updateUser(user.id, { role: 'admin' });
    expect(promoted.role).toBe('admin');
    expect(countActiveAdmins()).toBe(2);

    const disabled = updateUser(user.id, { status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    expect(countActiveAdmins()).toBe(1);

    // ... and the bootstrap admin is now the last one.
    expect(() => updateUser(bootstrap.id, { status: 'disabled' })).toThrow(UserRuleError);
  });

  it('refuses to disable, delete or demote the last active admin', () => {
    const admin = ensureBootstrapAdmin(NOW);
    expect(() => updateUser(admin.id, { status: 'disabled' })).toThrow(UserRuleError);
    expect(() => updateUser(admin.id, { role: 'member' })).toThrow(UserRuleError);
    expect(() => deleteUser(admin.id)).toThrow(UserRuleError);
    expect(updateUser(admin.id, { displayName: 'Renamed' }).displayName).toBe('Renamed');
    expect(countActiveAdmins()).toBe(1);
  });

  it('allows demoting an admin once a second active admin exists', () => {
    const first = ensureBootstrapAdmin(NOW);
    const second = createUser({ username: 'second', password: 'Str0ng-Passphrase-1', role: 'admin' });
    expect(() => updateUser(first.id, { role: 'member' })).not.toThrow();
    expect(countActiveAdmins()).toBe(1);
    expect(() => updateUser(second.id, { role: 'member' })).toThrow(UserRuleError);
  });

  it('refuses self-disable and self-demotion when the actor is known', () => {
    const admin = ensureBootstrapAdmin(NOW);
    createUser({ username: 'other-admin', password: 'An0ther-Passphrase-2', role: 'admin' });
    expect(() => updateUser(admin.id, { status: 'disabled' }, NOW, { actorId: admin.id })).toThrow(
      /your own account/,
    );
    expect(() => updateUser(admin.id, { role: 'member' }, NOW, { actorId: admin.id })).toThrow(
      /your own admin role/,
    );
    expect(() => deleteUser(admin.id, NOW, { actorId: admin.id })).toThrow(/your own account/);
    // Another admin may still disable them.
    expect(updateUser(admin.id, { status: 'disabled' }, NOW, { actorId: 'someone-else' }).status).toBe(
      'disabled',
    );
  });

  it('rejects invalid update payloads and unknown ids', () => {
    const user = makeUser('payload');
    expect(() => updateUser(user.id, { role: 'owner' })).toThrow(UserValidationError);
    expect(() => updateUser(user.id, { status: 'pending' })).toThrow(UserValidationError);
    expect(() => updateUser(user.id, { displayName: 42 })).toThrow(/must be a string/);
    expect(() => updateUser('missing-id', { displayName: 'x' })).toThrow(UserNotFoundError);
  });

  it('revokes sessions when a user is disabled', () => {
    const user = makeUser('session-holder');
    const session = createSession(user.id, { now: NOW });
    updateUser(user.id, { status: 'disabled' }, NOW + 10);
    const row = queryOne<{ revoked_at: number | null }>(
      'SELECT revoked_at FROM user_sessions WHERE id = ?',
      [session.sessionId],
    );
    expect(Number(row?.revoked_at)).toBe(NOW + 10);
  });
});

describe('users: password reset', () => {
  it('stores a new hash and invalidates the old password', () => {
    const user = makeUser('resetme');
    setUserPassword(user.id, 'Brand-New-Pass1', NOW);
    expect(authenticateUser('resetme', TEST_MEMBER_PASSWORD, NOW)).toBeNull();
    expect(authenticateUser('resetme', 'Brand-New-Pass1', NOW)?.id).toBe(user.id);
  });

  it('revokes every session of the user', () => {
    const user = makeUser('reset-sessions');
    const first = createSession(user.id, { now: NOW });
    const second = createSession(user.id, { now: NOW });
    setUserPassword(user.id, 'Brand-New-Pass1', NOW + 5);
    const rows = queryAll<{ id: string; revoked_at: number | null }>(
      'SELECT id, revoked_at FROM user_sessions WHERE user_id = ?',
      [user.id],
    );
    expect(rows.map((row) => row.id).sort()).toEqual([first.sessionId, second.sessionId].sort());
    for (const row of rows) expect(Number(row.revoked_at)).toBe(NOW + 5);
  });

  it('keeps the current session when it is passed explicitly', () => {
    const user = makeUser('reset-keep');
    const current = createSession(user.id, { now: NOW });
    const other = createSession(user.id, { now: NOW });
    setUserPassword(user.id, 'Brand-New-Pass1', NOW + 5, current.sessionId);
    const rows = queryAll<{ id: string; revoked_at: number | null }>(
      'SELECT id, revoked_at FROM user_sessions WHERE user_id = ?',
      [user.id],
    );
    const byId = new Map(rows.map((row) => [String(row.id), row.revoked_at]));
    expect(byId.get(current.sessionId)).toBeNull();
    expect(Number(byId.get(other.sessionId))).toBe(NOW + 5);
  });

  it('enforces the password policy and unknown ids', () => {
    const user = makeUser('resetpolicy');
    expect(() => setUserPassword(user.id, 'short')).toThrow(UserValidationError);
    expect(() => setUserPassword(user.id, 'resetpolicy123')).toThrow(/username/);
    expect(() => setUserPassword('missing', 'Brand-New-Pass1')).toThrow(UserNotFoundError);
  });

  it('never stores the plaintext password', () => {
    const user = makeUser('nosnoop');
    setUserPassword(user.id, 'Brand-New-Pass1', NOW);
    const row = queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [
      user.id,
    ]);
    expect(String(row?.password_hash)).toMatch(/^scrypt\$16384,8,1\$/);
    expect(String(row?.password_hash)).not.toContain('Brand-New-Pass1');
  });
});

describe('users: deletion', () => {
  it('deletes a member and cascades the sessions', () => {
    const user = makeUser('deletable');
    createSession(user.id, { now: NOW });
    expect(deleteUser(user.id, NOW)).toBe(true);
    expect(getUserById(user.id)).toBeNull();
    expect(queryAll('SELECT id FROM user_sessions WHERE user_id = ?', [user.id])).toHaveLength(0);
  });

  it('returns false for an unknown id (idempotent)', () => {
    expect(deleteUser('missing')).toBe(false);
    expect(deleteUser(undefined)).toBe(false);
  });

  it('deletes an admin as long as another active admin remains', () => {
    const first = ensureBootstrapAdmin(NOW);
    const second = createUser({ username: 'keeper', password: 'Kept-Secr3t-Value', role: 'admin' });
    expect(deleteUser(first.id)).toBe(true);
    expect(countActiveAdmins()).toBe(1);
    expect(() => deleteUser(second.id)).toThrow(UserRuleError);
  });
});

describe('users: rules exported for the route layer', () => {
  it('re-exports validateUsername', () => {
    expect(validateUsername('ok-name')).toBeNull();
    expect(validateUsername('no')).toMatch(/at least 3/);
  });
});
