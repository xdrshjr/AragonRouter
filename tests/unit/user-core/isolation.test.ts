import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import {
  ApiError,
  isUnauthorized,
  listKeys,
  signIn,
} from '@/components/console/api';
import {
  resetSessionExpiredListeners,
  subscribeSessionExpired,
} from '@/components/console/session-expiry';
import { mapDomainError, withAuth } from '@/lib/api-helpers';
import { CAPTCHA_MAX_ATTEMPTS, createCaptcha, verifyCaptcha } from '@/lib/captcha';
import { queryOne } from '@/lib/db';
import {
  SESSION_COOKIE,
  authenticateRequest,
  authenticateSessionToken,
  createSession,
  listUserSessions,
  revokeAllSessions,
} from '@/lib/sessions';
import {
  UserRuleError,
  countActiveAdmins,
  createUser,
  deleteUser,
  ensureBootstrapAdmin,
  getUserById,
  listUsers,
  setUserPassword,
  updateUser,
} from '@/lib/users';
import {
  TEST_ADMIN_PASSWORD,
  TEST_MEMBER_PASSWORD,
  createMemberUser,
  jsonRequest,
  prepareTestEnv,
  readJson,
} from '../test-helpers';

/**
 * Cross-module boundary tests for the multi-account kernel (WP user-core).
 *
 * Every case here stitches two or more modules together the way production does, in
 * areas the per-module suites cannot see:
 *
 *  - one account's writes (`revokeAllSessions`, `setUserPassword`, `updateUser`,
 *    `deleteUser`) must not reach another account's sessions or rows;
 *  - the guard's *status code* drives the console's session-expiry signal: a real
 *    `withAdmin` 403 (member) must never look like an expired session (C-GUARD),
 *    while a real 401 must;
 *  - the "last active admin" invariant has to hold against the *active* count, so a
 *    disabled second admin must not be mistaken for a rescue;
 *  - captcha challenges are independent: burning one must not burn another;
 *  - a session id from one account and a secret from another must never authenticate.
 */

const BASE = 'http://localhost';

beforeEach(() => {
  prepareTestEnv();
  resetSessionExpiredListeners();
});

afterEach(() => {
  resetSessionExpiredListeners();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return jsonRequest(`${BASE}${path}`, { method: 'GET', headers });
}

/**
 * Install a `fetch` stub that resolves the console client's relative admin URLs to the
 * *real* route handlers, carrying the cookie a browser would send.
 *
 * This is the boundary the console depends on: `api.ts` on one side, `withAdmin` /
 * `withAuth` on the other, with no HTTP server in between.
 */
function installConsoleFetch(sessionToken: string | null): { calls: string[] } {
  const calls: string[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, BASE);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(
      init?.headers === undefined
        ? undefined
        : (init.headers as ConstructorParameters<typeof Headers>[0]),
    );
    if (sessionToken !== null) headers.set('cookie', `${SESSION_COOKIE}=${sessionToken}`);
    calls.push(`${method} ${url.pathname}`);

    const request = new Request(url, {
      method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.pathname === '/api/admin/keys') {
      const handler = method === 'GET' ? keysRoute.GET : undefined;
      if (!handler) throw new Error(`console stub: ${method} ${url.pathname} is not implemented`);
      return handler(request);
    }
    if (url.pathname === '/api/admin/session' && method === 'POST') {
      return sessionRoute.POST(request);
    }
    throw new Error(`console stub: unexpected request ${method} ${url.pathname}`);
  };
  vi.stubGlobal('fetch', stub as unknown as typeof fetch);
  return { calls };
}

/** Count the session-expiry notifications the console shell would act on. */
function countExpirySignals(): { count: () => number } {
  let fired = 0;
  subscribeSessionExpired(() => {
    fired += 1;
  });
  return { count: () => fired };
}

describe('boundary: one account cannot reach another account', () => {
  it('revokes only the targeted account\'s devices', () => {
    const alice = createMemberUser('alice', { password: 'Quiet-P4ssw0rd-1' });
    const bob = createMemberUser('bob', { password: 'Loud-P4ssw0rd-22' });
    const aliceSession = createSession(alice.id, { userAgent: 'alice-laptop' });
    const alicePhone = createSession(alice.id, { userAgent: 'alice-phone' });
    const bobSession = createSession(bob.id, { userAgent: 'bob-laptop' });

    expect(revokeAllSessions(alice.id)).toBe(2);

    expect(authenticateSessionToken(aliceSession.token)).toBeNull();
    expect(authenticateSessionToken(alicePhone.token)).toBeNull();
    // Bob's credential is untouched by another account's "log out everywhere".
    expect(authenticateSessionToken(bobSession.token)?.user.id).toBe(bob.id);
    expect(listUserSessions(bob.id).map((device) => device.userAgent)).toEqual(['bob-laptop']);
    expect(listUserSessions(alice.id)).toHaveLength(0);
  });

  it('disabling and deleting one account leaves the other signed in', async () => {
    const admin = ensureBootstrapAdmin();
    const alice = createMemberUser('alice', { password: 'Quiet-P4ssw0rd-1' });
    const bob = createMemberUser('bob', { password: 'Loud-P4ssw0rd-22' });
    const aliceSession = createSession(alice.id, { userAgent: 'alice-laptop' });
    const bobSession = createSession(bob.id, { userAgent: 'bob-laptop' });

    updateUser(alice.id, { status: 'disabled' }, Date.now(), { actorId: admin.id });
    expect(authenticateSessionToken(aliceSession.token)).toBeNull();
    expect(authenticateSessionToken(bobSession.token)?.user.username).toBe('bob');
    // The any-role guard still lets the untouched account through.
    const allowed = await withAuth(
      getRequest('/api/account', cookieHeader(bobSession.token)),
      (_request, context) => new Response(JSON.stringify({ data: { id: context.user.id } })),
    );
    expect(allowed.status).toBe(200);
    expect(await readJson(allowed)).toEqual({ data: { id: bob.id } });

    expect(deleteUser(alice.id)).toBe(true);
    expect(getUserById(alice.id)).toBeNull();
    expect(authenticateSessionToken(bobSession.token)?.user.id).toBe(bob.id);
    expect(
      queryOne<{ rows: number }>('SELECT COUNT(*) AS rows FROM user_sessions WHERE user_id = ?', [
        bob.id,
      ])?.rows,
    ).toBe(1);
  });

  it('a password reset on one account does not sign the other account out', () => {
    const alice = createMemberUser('alice', { password: 'Quiet-P4ssw0rd-1' });
    const bob = createMemberUser('bob', { password: 'Loud-P4ssw0rd-22' });
    const aliceSession = createSession(alice.id, { userAgent: 'alice-laptop' });
    const bobSession = createSession(bob.id, { userAgent: 'bob-laptop' });

    setUserPassword(alice.id, 'Rotated-Quiet-P4ss');

    expect(authenticateSessionToken(aliceSession.token)).toBeNull();
    expect(authenticateSessionToken(bobSession.token)?.user.id).toBe(bob.id);
    expect(listUserSessions(bob.id)).toHaveLength(1);
    // Bob's own password is unchanged by Alice's reset.
    expect(authenticateRequest(getRequest('/x', cookieHeader(bobSession.token)))?.user.username).toBe(
      'bob',
    );
  });

  it('never authenticates a session id from one account with another account\'s secret', () => {
    const alice = createMemberUser('alice', { password: 'Quiet-P4ssw0rd-1' });
    const bob = createMemberUser('bob', { password: 'Loud-P4ssw0rd-22' });
    const aliceSession = createSession(alice.id);
    const bobSession = createSession(bob.id);
    const aliceSecret = aliceSession.token.split('.')[1] ?? '';
    const bobSecret = bobSession.token.split('.')[1] ?? '';

    expect(authenticateSessionToken(`${aliceSession.sessionId}.${bobSecret}`)).toBeNull();
    expect(authenticateSessionToken(`${bobSession.sessionId}.${aliceSecret}`)).toBeNull();
    // ... while each real pair still resolves to its own owner.
    expect(authenticateSessionToken(aliceSession.token)?.user.id).toBe(alice.id);
    expect(authenticateSessionToken(bobSession.token)?.user.id).toBe(bob.id);
  });
});

describe('boundary: guard status code -> console session-expiry signal (C-GUARD)', () => {
  it('raises the console signal for a real 401 from the guarded route', async () => {
    const signals = countExpirySignals();
    installConsoleFetch(null);

    const error = await listKeys().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(isUnauthorized(error)).toBe(true);
    expect(signals.count()).toBe(1);
  });

  it('does not raise the console signal for a real 403 from the guarded route', async () => {
    const member = createMemberUser('member-ui');
    const session = createSession(member.id, { userAgent: 'member-ui' });
    const signals = countExpirySignals();
    installConsoleFetch(session.token);

    const error = await listKeys().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    // C-GUARD: "you may not do this" must not masquerade as "sign in again".
    expect(isUnauthorized(error)).toBe(false);
    expect((error as ApiError).message).toBe('forbidden');
    expect(signals.count()).toBe(0);
    // The 403 is not a side effect on the credential either: the member is still live.
    expect(authenticateSessionToken(session.token)?.user.username).toBe('member-ui');
    expect(authenticateRequest(getRequest('/x', cookieHeader(session.token)))?.user.role).toBe(
      'member',
    );
  });

  it('lets a real admin session through the console client without any signal', async () => {
    const admin = ensureBootstrapAdmin();
    const session = createSession(admin.id, { userAgent: 'admin-ui' });
    const signals = countExpirySignals();
    const stub = installConsoleFetch(session.token);

    await expect(listKeys()).resolves.toEqual([]);
    expect(stub.calls).toEqual(['GET /api/admin/keys']);
    expect(signals.count()).toBe(0);
  });

  it('keeps a wrong password and a member credential off the expiry signal', async () => {
    ensureBootstrapAdmin();
    createMemberUser('door-member');
    const signals = countExpirySignals();
    installConsoleFetch(null);

    const wrongPassword = await signIn('not-the-password').catch((caught: unknown) => caught);
    expect(wrongPassword).toBeInstanceOf(ApiError);
    expect((wrongPassword as ApiError).status).toBe(401);
    expect(isUnauthorized(wrongPassword)).toBe(true);
    // `POST /session` is the documented exception: the login form shows this inline
    // instead of navigating, so no expiry signal may be raised for it.
    expect(signals.count()).toBe(0);

    // A member's *valid* credential on the admin door answers 403, not 401: the console
    // must show "forbidden" and stay put. The typed client posts `{password}` only, so
    // the named-account body goes straight to the real handler (the auth-api surface).
    const memberDoor = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, {
        body: { username: 'door-member', password: TEST_MEMBER_PASSWORD },
      }),
    );
    expect(memberDoor.status).toBe(403);
    expect(await readJson(memberDoor)).toEqual({ error: { message: 'forbidden' } });
    expect(signals.count()).toBe(0);

    // The admin credential still works through the same client afterwards.
    await expect(signIn(TEST_ADMIN_PASSWORD)).resolves.toBeUndefined();
    expect(signals.count()).toBe(0);
  });
});

describe('boundary: the last *active* admin invariant', () => {
  /** admin1 plus a second admin that is switched off: only one active admin remains. */
  function twoAdminsOneDisabled(): { controller: string; disabled: string } {
    const admin = ensureBootstrapAdmin();
    const second = createUser({ username: 'controller', password: 'Zq7-Quiet-Value-2', role: 'admin' });
    updateUser(second.id, { status: 'disabled' }, Date.now(), { actorId: admin.id });
    return { controller: admin.id, disabled: second.id };
  }

  it('refuses to demote the only active admin while the other admin is disabled', async () => {
    const { controller, disabled } = twoAdminsOneDisabled();
    expect(countActiveAdmins()).toBe(1);

    const captured = (() => {
      try {
        updateUser(controller, { role: 'member' }, Date.now(), { actorId: 'someone-else' });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(captured).toBeInstanceOf(UserRuleError);
    expect((captured as Error).message).toMatch(/active admin/);
    const mapped = mapDomainError(captured);
    expect(mapped?.status).toBe(400);
    expect(await readJson(mapped as Response)).toEqual({
      error: { message: 'at least one active admin must remain' },
    });

    // The refused change left both rows exactly as they were.
    expect(getUserById(controller)?.role).toBe('admin');
    expect(getUserById(controller)?.status).toBe('active');
    expect(getUserById(disabled)?.status).toBe('disabled');
    expect(countActiveAdmins()).toBe(1);
  });

  it('refuses to delete the only active admin while the other admin is disabled', () => {
    const { controller, disabled } = twoAdminsOneDisabled();

    expect(() => deleteUser(controller, Date.now(), { actorId: 'someone-else' })).toThrow(
      UserRuleError,
    );
    expect(getUserById(controller)).not.toBeNull();
    expect(getUserById(disabled)).not.toBeNull();
    expect(countActiveAdmins()).toBe(1);
  });

  it('allows the change once the second admin is active again', () => {
    const { controller, disabled } = twoAdminsOneDisabled();
    updateUser(disabled, { status: 'active' }, Date.now(), { actorId: controller });
    expect(countActiveAdmins()).toBe(2);

    const demoted = updateUser(controller, { role: 'member' }, Date.now(), { actorId: disabled });
    expect(demoted.role).toBe('member');
    expect(countActiveAdmins()).toBe(1);
    expect(getUserById(disabled)?.role).toBe('admin');
  });
});

describe('boundary: captcha challenges are independent', () => {
  it('burns one challenge without touching another', () => {
    const now = Date.now();
    const first = createCaptcha(now, { answer: 'ABCDE' });
    const second = createCaptcha(now, { answer: 'ABCDE' });

    for (let attempt = 0; attempt < CAPTCHA_MAX_ATTEMPTS; attempt += 1) {
      expect(verifyCaptcha(first.id, 'ZZZZZ', now)).toBe(false);
    }
    // The first challenge is spent: even the right answer is refused now.
    expect(verifyCaptcha(first.id, 'abcde', now)).toBe(false);
    // The second one is untouched and still accepts its answer, case-insensitively.
    expect(verifyCaptcha(second.id, 'abcde', now)).toBe(true);
    expect(verifyCaptcha(second.id, 'abcde', now)).toBe(false);
  });

  it('never consumes a challenge with another challenge\'s answer', () => {
    const now = Date.now();
    const target = createCaptcha(now, { answer: 'ABCDE' });
    const other = createCaptcha(now, { answer: 'XYZ23' });

    // The answer of challenge `other` is wrong for `target`...
    expect(verifyCaptcha(target.id, 'XYZ23', now)).toBe(false);
    // ... and did not consume `target`, whose own answer still works exactly once.
    expect(verifyCaptcha(target.id, 'ABCDE', now)).toBe(true);
    // ... and left `other` spendable too.
    expect(verifyCaptcha(other.id, 'xyz23', now)).toBe(true);
  });
});

describe('boundary: exact boundary conditions shared across modules', () => {
  it('treats a session as dead at the exact instant it expires', async () => {
    const now = 1_700_000_000_000;
    const session = createSession(ensureBootstrapAdmin(now).id, { now, ttlMs: 1_000 });

    // One millisecond before the deadline the credential is still good...
    expect(authenticateSessionToken(session.token, session.expiresAt - 1)?.user.username).toBe(
      'admin',
    );
    // ... and at the deadline itself it is not: `expires_at <= now` is expired.
    expect(authenticateSessionToken(session.token, session.expiresAt)).toBeNull();
    // Same answer through the guard: a token the store rejects is never trusted, and the
    // 401 carries the C-GUARD body rather than the handler's response.
    const guarded = await withAuth(
      getRequest('/api/account', cookieHeader(session.token)),
      () => new Response('should not run'),
    );
    expect(guarded.status).toBe(401);
    expect(await readJson(guarded)).toEqual({ error: { message: 'unauthorized' } });
  });

  it('treats a captcha as dead at the exact instant it expires', () => {
    const now = 1_700_000_000_000;
    const stale = createCaptcha(now, { answer: 'ABCDE' });
    const fresh = createCaptcha(now, { answer: 'ABCDE' });

    expect(verifyCaptcha(stale.id, 'ABCDE', stale.expiresAtMs)).toBe(false);
    expect(verifyCaptcha(fresh.id, 'ABCDE', fresh.expiresAtMs - 1)).toBe(true);
  });

  it('paginates users that share the same created_at without repeating or skipping', () => {
    const stamp = 1_700_000_000_000;
    const created = ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e'].map((username) =>
      createUser({ username, password: TEST_MEMBER_PASSWORD }, stamp),
    );
    expect(new Set(created.map((user) => user.createdAt))).toEqual(
      new Set([new Date(stamp).toISOString()]),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = listUsers({ limit: 2, cursor });
      seen.push(...result.data.map((user) => user.username));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    // Five rows, five pages worth of walking, no duplicates and nothing skipped: the
    // `(created_at, id)` tie-break is what makes an all-equal timestamp safe.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual(['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e']);
  });

  it('writes last_seen_at exactly at the throttle boundary, not before', () => {
    const now = 1_700_000_000_000;
    const admin = ensureBootstrapAdmin(now);
    const session = createSession(admin.id, { now, ttlMs: 60 * 60 * 1000 });

    const beforeInterval = authenticateSessionToken(session.token, now + 59_999);
    expect(beforeInterval?.session.lastSeenAt).toBe(new Date(now).toISOString());
    expect(
      queryOne<{ last_seen_at: number }>('SELECT last_seen_at FROM user_sessions WHERE id = ?', [
        session.sessionId,
      ])?.last_seen_at,
    ).toBe(now);

    const atInterval = authenticateSessionToken(session.token, now + 60_000);
    expect(atInterval?.session.lastSeenAt).toBe(new Date(now + 60_000).toISOString());
    expect(
      queryOne<{ last_seen_at: number }>('SELECT last_seen_at FROM user_sessions WHERE id = ?', [
        session.sessionId,
      ])?.last_seen_at,
    ).toBe(now + 60_000);
  });
});
