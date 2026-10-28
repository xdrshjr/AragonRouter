import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import { mapDomainError, withAdmin, withAuth } from '@/lib/api-helpers';
import { endSession, verifyAdminPassword, verifySessionToken } from '@/lib/auth';
import { CAPTCHA_TTL_MS, captchaDataUrl, createCaptcha, verifyCaptcha } from '@/lib/captcha';
import { sha256Hex } from '@/lib/crypto';
import { queryOne } from '@/lib/db';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  authenticateRequest,
  createSession,
  getSessionById,
  getSessionTokenFromRequest,
  listUserSessions,
  parseSessionToken,
  revokeAllSessions,
  revokeSession,
} from '@/lib/sessions';
import { RegistrationClosedError, assertRegistrationOpen, setRegistrationEnabled } from '@/lib/settings';
import {
  UserRuleError,
  authenticateUser,
  createUser,
  deleteUser,
  ensureBootstrapAdmin,
  getUserById,
  listUsers,
  setUserPassword,
  updateUser,
} from '@/lib/users';
import type { UserDetailPublic, UserPublic, UserSessionPublic } from '@/lib/types';
import {
  TEST_ADMIN_PASSWORD,
  TEST_MEMBER_PASSWORD,
  createMemberUser,
  jsonRequest,
  prepareTestEnv,
  readJson,
} from '../test-helpers';

/**
 * Cross-module boundary tests for the account kernel (WP user-core).
 *
 * Every case here stitches two or more modules together the way production does, so
 * that "each unit works alone" cannot hide an integration break:
 *
 *  - route handler  ↔ `withAdmin`/`withAuth` ↔ `sessions` ↔ `users`
 *  - `users` writes (disable / password reset / delete) ↔ a live session cookie that
 *    is already in a client's hands
 *  - `captcha` + `settings` ↔ the HTTP contract the auth routes and the UI consume
 *  - every DTO that leaves the kernel, swept for credentials (acceptance criterion 8)
 *
 * C-TOKEN shape is pinned against the contract regex rather than against
 * `session-gate`'s own copy, because the console gate is a *consumer* of this format
 * and must follow it.
 */

/** C-TOKEN: `<32 hex sessionId>.<64 hex secret>`, the shape `session-gate` matches. */
const CONTRACT_TOKEN_PATTERN = /^[0-9a-f]{32}\.[0-9a-f]{64}$/i;
const BASE = 'http://localhost';

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return jsonRequest(`${BASE}${path}`, { method: 'GET', headers });
}

/** Log out through the real route handler, carrying the given cookie. */
function deleteRequest(headers: Record<string, string> = {}): Request {
  return jsonRequest(`${BASE}/api/admin/session`, { method: 'DELETE', headers });
}

/** Sign in through the real route handler and return the minted cookie header. */
async function signInAsAdmin(): Promise<string> {
  const response = await sessionRoute.POST(
    jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
  );
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('boundary: login route -> guard -> admin route -> session store', () => {
  it('carries one credential from the login response to a guarded admin route', async () => {
    const cookie = await signInAsAdmin();
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);

    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    // C-TOKEN: the value the route mints is what the console gate must accept.
    expect(token).toMatch(CONTRACT_TOKEN_PATTERN);
    expect(parseSessionToken(token)).toEqual({
      sessionId: token.split('.')[0],
      secret: token.split('.')[1],
    });

    // The row exists, stores only sha256(secret) and expires after seven days.
    const sessionId = token.split('.')[0] ?? '';
    const secret = token.split('.')[1] ?? '';
    const row = queryOne<{ token_hash: string; expires_at: number; user_id: string }>(
      'SELECT token_hash, expires_at, user_id FROM user_sessions WHERE id = ?',
      [sessionId],
    );
    expect(row?.token_hash).toBe(sha256Hex(secret));
    expect(Number(row?.expires_at)).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5_000);
    expect(getUserById(String(row?.user_id))?.username).toBe('admin');

    // ... and the guard accepts exactly that cookie on a real admin route.
    const guarded = await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(token)));
    expect(guarded.status).toBe(200);

    // Logging out through the session-store helper retires the very same credential.
    expect(endSession(getRequest('/api/admin/session', cookieHeader(token)))).toBe(true);
    const afterLogout = await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(token)));
    expect(afterLogout.status).toBe(401);
    expect(await readJson(afterLogout)).toEqual({ error: { message: 'unauthorized' } });
  });

  it('accepts the bearer form the PowerShell scripts use on a guarded route', async () => {
    const cookie = await signInAsAdmin();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    const viaBearer = await sessionRoute.GET(
      getRequest('/api/admin/session', { authorization: `Bearer ${token}` }),
    );
    expect(viaBearer.status).toBe(200);
    // A `Bearer ar-...` client key is not a session and must never be one.
    const wrongScheme = await sessionRoute.GET(
      getRequest('/api/admin/session', { authorization: 'Bearer ar-0123456789abcdef0123456789abcdef' }),
    );
    expect(wrongScheme.status).toBe(401);
  });

  it('separates member (403) from anonymous (401) on the same guarded route', async () => {
    const member = createMemberUser('boundary-member');
    const memberSession = createSession(member.id, { userAgent: 'boundary-member' });

    const asMember = await keysRoute.GET(
      getRequest('/api/admin/keys', cookieHeader(memberSession.token)),
    );
    expect(asMember.status).toBe(403);
    const memberBody = await readJson(asMember);
    expect(memberBody).toEqual({ error: { message: 'forbidden' } });
    // The console keys its redirect on 401 only, so 403 must not borrow that body.
    expect(memberBody).not.toEqual({ error: { message: 'unauthorized' } });

    const anonymous = await keysRoute.GET(getRequest('/api/admin/keys'));
    expect(anonymous.status).toBe(401);
    expect(await readJson(anonymous)).toEqual({ error: { message: 'unauthorized' } });

    // `withAuth` is the any-role guard: the same member is welcomed there.
    const anyRole = await withAuth(
      getRequest('/api/account', cookieHeader(memberSession.token)),
      (_request, context) => new Response(JSON.stringify({ data: { id: context.user.id } })),
    );
    expect(anyRole.status).toBe(200);
    expect(await readJson(anyRole)).toEqual({ data: { id: member.id } });
  });

  it('refuses a session that a repository call revoked, on the guarded route', async () => {
    ensureBootstrapAdmin();
    const cookie = await signInAsAdmin();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    const context = authenticateRequest(getRequest('/api/admin/session', cookieHeader(token)));
    expect(context).not.toBeNull();

    // `revokeSession` is the primitive the user-management "force sign-out" uses.
    expect(revokeSession(context?.session.id ?? '')).toBe(true);
    const response = await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(token)));
    expect(response.status).toBe(401);
  });

  it('never hands a usable cookie to an account that is already disabled', async () => {
    const admin = ensureBootstrapAdmin();
    createUser({ username: 'controller', password: 'Zq7-Quiet-Value-2', role: 'admin' });
    updateUser(admin.id, { status: 'disabled' }, Date.now(), { actorId: 'another-admin' });

    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    // Regression: the route used to answer 200 + Set-Cookie for a disabled owner
    // (the hash still verified). The credential is refused at the door now, and no
    // session row is spent on it.
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await readJson(response)).toEqual({ error: { message: 'invalid password' } });
    expect(queryOne('SELECT id FROM user_sessions WHERE user_id = ?', [admin.id])).toBeUndefined();

    // Defence in depth: the legacy hash-only helper refuses it too, and so does the
    // credential store.
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(false);
    expect(authenticateUser('admin', TEST_ADMIN_PASSWORD)).toBeNull();
  });

  it('keeps the door shut for a re-enabled account only with a fresh credential', async () => {
    const admin = ensureBootstrapAdmin();
    createUser({ username: 'controller-2', password: 'Zq7-Quiet-Value-3', role: 'admin' });
    updateUser(admin.id, { status: 'disabled' }, Date.now(), { actorId: 'another-admin' });
    updateUser(admin.id, { status: 'active' }, Date.now(), { actorId: 'another-admin' });

    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });
});

describe('boundary: sign-out retires the credential, not just the cookie', () => {
  it('revokes the session row so a copied cookie stops working', async () => {
    const cookie = await signInAsAdmin();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    const sessionId = token.split('.')[0] ?? '';
    expect(getSessionById(sessionId)?.revoked_at).toBeNull();

    const logout = await sessionRoute.DELETE(deleteRequest(cookieHeader(token)));
    expect(logout.status).toBe(200);
    expect(await readJson(logout)).toEqual({ data: { ok: true } });
    expect(logout.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

    // Regression: DELETE used to clear the cookie without touching `user_sessions`,
    // so the same value kept authenticating for the rest of its seven-day TTL.
    expect(getSessionById(sessionId)?.revoked_at).not.toBeNull();
    expect(verifySessionToken(token)).toBe(false);
    const replay = await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(token)));
    expect(replay.status).toBe(401);
    expect(await readJson(replay)).toEqual({ error: { message: 'unauthorized' } });
  });

  it('lets a member end their own session (withAuth, not withAdmin)', async () => {
    const member = createMemberUser('logout-member');
    const session = createSession(member.id, { userAgent: 'member-device' });

    const logout = await sessionRoute.DELETE(deleteRequest(cookieHeader(session.token)));
    expect(logout.status).toBe(200);
    expect(getSessionById(session.sessionId)?.revoked_at).not.toBeNull();
    expect(authenticateRequest(getRequest('/api/admin/session', cookieHeader(session.token)))).toBeNull();
  });

  it('answers 401 - never 500 - when there is no session left to end', async () => {
    const cookie = await signInAsAdmin();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);

    const first = await sessionRoute.DELETE(deleteRequest(cookieHeader(token)));
    expect(first.status).toBe(200);
    const second = await sessionRoute.DELETE(deleteRequest(cookieHeader(token)));
    expect(second.status).toBe(401);
    expect(await readJson(second)).toEqual({ error: { message: 'unauthorized' } });
  });

  it('records the device of a login and never echoes the credential', async () => {
    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, {
        body: { password: TEST_ADMIN_PASSWORD },
        headers: { 'user-agent': 'login-device/2.0', 'x-forwarded-for': '203.0.113.9' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ data: { ok: true } });
    const token = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(body).not.toContain(token.split('=')[1] ?? '#');

    const admin = ensureBootstrapAdmin();
    const devices = listUserSessions(admin.id);
    expect(devices.some((device) => device.userAgent === 'login-device/2.0')).toBe(true);
    expect(devices.some((device) => device.ip === '203.0.113.9')).toBe(true);
  });

  it('refuses a member credential on the admin door with 403, not a false success', async () => {
    createMemberUser('door-member');
    const response = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, {
        body: { username: 'door-member', password: TEST_MEMBER_PASSWORD },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await readJson(response)).toEqual({ error: { message: 'forbidden' } });
  });

  it('accepts a named admin account and rejects a malformed username', async () => {
    ensureBootstrapAdmin();
    createUser({ username: 'second-admin', password: 'Kx4-Quiet-Value-8', role: 'admin' });

    const named = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, {
        body: { username: 'second-admin', password: 'Kx4-Quiet-Value-8' },
      }),
    );
    expect(named.status).toBe(200);
    expect(named.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);

    const bad = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { username: 'not a user!', password: 'x' } }),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
  });
});

describe('boundary: account-repository writes reach live sessions', () => {
  it('kills the cookie immediately when the owner is disabled, and does not revive it', async () => {
    const admin = ensureBootstrapAdmin();
    createUser({ username: 'controller', password: 'Zq7-Quiet-Value-2', role: 'admin' });
    const session = createSession(admin.id, { userAgent: 'admin-laptop' });
    const headers = cookieHeader(session.token);

    expect((await keysRoute.GET(getRequest('/api/admin/keys', headers))).status).toBe(200);

    updateUser(admin.id, { status: 'disabled' }, Date.now(), { actorId: 'another-admin' });
    expect((await keysRoute.GET(getRequest('/api/admin/keys', headers))).status).toBe(401);
    expect(listUserSessions(admin.id)).toHaveLength(0);
    expect(authenticateUser('admin', TEST_ADMIN_PASSWORD)).toBeNull();

    // Re-enabling the account must not hand the old cookie back to its holder.
    updateUser(admin.id, { status: 'active' });
    expect((await keysRoute.GET(getRequest('/api/admin/keys', headers))).status).toBe(401);
    expect(verifySessionToken(session.token)).toBe(false);
    expect(authenticateUser('admin', TEST_ADMIN_PASSWORD)).not.toBeNull();
  });

  it('logs out every other device on a password reset but keeps the current one', async () => {
    const user = createMemberUser('reset-boundary');
    const current = createSession(user.id, { userAgent: 'current-device' });
    const other = createSession(user.id, { userAgent: 'other-device' });

    setUserPassword(user.id, 'Rotated-Passw0rd-9', Date.now(), current.sessionId);

    expect(verifySessionToken(current.token)).toBe(true);
    expect(verifySessionToken(other.token)).toBe(false);
    // The old password is gone, the new one works, and only one device is listed.
    expect(authenticateUser('reset-boundary', TEST_MEMBER_PASSWORD)).toBeNull();
    expect(authenticateUser('reset-boundary', 'Rotated-Passw0rd-9')?.id).toBe(user.id);
    const devices = listUserSessions(user.id, { currentSessionId: current.sessionId });
    expect(devices.map((device) => device.userAgent)).toEqual(['current-device']);
    expect(devices[0]?.current).toBe(true);
  });

  it('drops the cookie and the account when a user is deleted', async () => {
    const user = createMemberUser('deleted-boundary');
    const session = createSession(user.id, { userAgent: 'doomed-device' });

    expect(deleteUser(user.id)).toBe(true);

    expect(verifySessionToken(session.token)).toBe(false);
    expect(getUserById(user.id)).toBeNull();
    const list = listUsers({ search: 'deleted-boundary' });
    expect(list.data).toHaveLength(0);
    expect(
      (await withAuth(getRequest('/api/account', cookieHeader(session.token)), () => new Response('x')))
        .status,
    ).toBe(401);
  });

  it('keeps the instance reachable: a repository rule becomes a 400 for the route layer', async () => {
    const admin = ensureBootstrapAdmin();
    const deleteCookie = await signInAsAdmin();
    const actorId = authenticateRequest(
      getRequest('/api/admin/session', cookieHeader(deleteCookie.slice(`${SESSION_COOKIE}=`.length))),
    )?.user.id;

    const ruleError = (() => {
      try {
        deleteUser(admin.id, Date.now(), { actorId });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(ruleError).toBeInstanceOf(UserRuleError);
    // C-USER-STORE: rules map to 400, never to 401 (which would sign the actor out).
    const mapped = mapDomainError(ruleError);
    expect(mapped?.status).toBe(400);
    const mappedBody = await readJson<{ error: { message: string } }>(mapped as Response);
    expect(mappedBody.error.message).toMatch(/your own account|active admin/);
    expect(getUserById(admin.id)).not.toBeNull();
  });

  it('deletes a user whose only session was already revoked without leaving orphan rows', async () => {
    const user = createMemberUser('orphan-check');
    const session = createSession(user.id);
    revokeSession(session.sessionId);
    expect(deleteUser(user.id)).toBe(true);
    expect(queryOne('SELECT id FROM user_sessions WHERE user_id = ?', [user.id])).toBeUndefined();
  });

  it('drops every session of a demoted-then-deleted account in one pass', async () => {
    const user = createUser({ username: 'multi-device', password: TEST_MEMBER_PASSWORD });
    createSession(user.id, { userAgent: 'a' });
    createSession(user.id, { userAgent: 'b' });

    expect(revokeAllSessions(user.id)).toBe(2);
    expect(listUserSessions(user.id)).toHaveLength(0);
    expect(deleteUser(user.id)).toBe(true);
  });
});

describe('boundary: captcha + registration switch as the auth routes will use them', () => {
  it('mints a captcha whose image decodes and whose answer only ever lives hashed', async () => {
    const created = createCaptcha(Date.now(), { answer: 'AB2DE' });
    const svg = Buffer.from(captchaDataUrl(created.svg).split(',')[1] ?? '', 'base64').toString('utf8');
    expect(svg).toContain('<svg');

    const row = queryOne<{ answer_hash: string; expires_at: number }>(
      'SELECT answer_hash, expires_at FROM captcha_challenges WHERE id = ?',
      [created.id],
    );
    expect(String(row?.answer_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row?.answer_hash)).not.toContain('AB2DE');
    expect(Number(row?.expires_at)).toBe(created.expiresAtMs);

    // The flow the login route performs: verify once, then the challenge is spent.
    expect(verifyCaptcha(created.id, 'ab2de', created.expiresAtMs - CAPTCHA_TTL_MS)).toBe(true);
    expect(verifyCaptcha(created.id, 'ab2de', created.expiresAtMs - CAPTCHA_TTL_MS)).toBe(false);
  });

  it('turns a closed registration switch into 403, not 401', () => {
    setRegistrationEnabled(false);
    const error = (() => {
      try {
        assertRegistrationOpen();
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(RegistrationClosedError);
    const mapped = mapDomainError(error);
    expect(mapped?.status).toBe(403);
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);
  });
});

describe('boundary: DTO contract shared with auth-api and the UI', () => {
  it('emits exactly the UserPublic / UserSessionPublic / UserDetailPublic fields', () => {
    const user = createMemberUser('dto-shape');
    const session = createSession(user.id, { userAgent: 'dto-device', ip: '10.2.3.4' });

    const publicUser = getUserById(user.id) as UserPublic;
    expect(Object.keys(publicUser).sort()).toEqual(
      ['createdAt', 'displayName', 'id', 'lastLoginAt', 'role', 'status', 'updatedAt', 'username'].sort(),
    );
    for (const field of ['createdAt', 'updatedAt'] as const) {
      expect(new Date(publicUser[field]).toISOString()).toBe(publicUser[field]);
    }

    const sessions: UserSessionPublic[] = listUserSessions(user.id, {
      currentSessionId: session.sessionId,
    });
    expect(Object.keys(sessions[0] as UserSessionPublic).sort()).toEqual(
      ['createdAt', 'current', 'expiresAt', 'id', 'ip', 'lastSeenAt', 'userAgent'].sort(),
    );
    expect(sessions[0]?.ip).toBe('10.2.3.4');

    // The detail DTO is the public user plus its device list: one shape, two modules.
    const detail: UserDetailPublic = { ...publicUser, sessions };
    expect(Object.keys(detail).sort()).toEqual(
      ['createdAt', 'displayName', 'id', 'lastLoginAt', 'role', 'sessions', 'status', 'updatedAt', 'username'].sort(),
    );
  });
});

describe('boundary: nothing confidential leaves the kernel', () => {
  const CAPTCHA_ANSWER = 'QW2RT';

  function forbiddenFragments(): string[] {
    return ['scrypt$', TEST_ADMIN_PASSWORD, TEST_MEMBER_PASSWORD, CAPTCHA_ANSWER, SESSION_COOKIE];
  }

  it('sweeps users, sessions, captcha and route payloads for credentials', async () => {
    const admin = ensureBootstrapAdmin();
    const member = createUser({ username: 'leak-member', password: TEST_MEMBER_PASSWORD });
    const memberSession = createSession(member.id, { userAgent: 'leak-device' });
    const cookie = await signInAsAdmin();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    const captcha = createCaptcha(Date.now(), { answer: CAPTCHA_ANSWER });
    const captchaHash = String(
      queryOne<{ answer_hash: string }>('SELECT answer_hash FROM captcha_challenges WHERE id = ?', [
        captcha.id,
      ])?.answer_hash,
    );

    const payloads: Array<[string, string]> = [
      ['listUsers', JSON.stringify(listUsers({ limit: 50 }).data)],
      ['getUserById', JSON.stringify(getUserById(member.id))],
      ['listUserSessions', JSON.stringify(listUserSessions(member.id))],
      ['authenticateUser', JSON.stringify(authenticateUser('leak-member', TEST_MEMBER_PASSWORD))],
      ['setUserPassword', JSON.stringify(setUserPassword(member.id, 'Rotated-P4ssphrase-Z'))],
      ['captcha challenge', JSON.stringify({ id: captcha.id, svg: captcha.svg, expiresAt: captcha.expiresAt })],
      ['keys route (admin)', await (await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(token)))).text()],
      ['keys route (member)', await (await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(memberSession.token)))).text()],
      ['keys route (anonymous)', await (await keysRoute.GET(getRequest('/api/admin/keys'))).text()],
      ['login body', await (await sessionRoute.POST(
        jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
      )).text()],
      ['session probe 403', await (await sessionRoute.GET(getRequest('/api/admin/session', cookieHeader(memberSession.token)))).text()],
    ];

    const storedHash = String(
      queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [admin.id])
        ?.password_hash,
    );
    expect(storedHash).toMatch(/^scrypt\$16384,8,1\$/);

    for (const [label, payload] of payloads) {
      for (const fragment of forbiddenFragments()) {
        expect(payload, `${label} leaked ${fragment}`).not.toContain(fragment);
      }
      expect(payload, `${label} leaked the admin hash`).not.toContain(storedHash);
      expect(payload, `${label} leaked the session token`).not.toContain(token);
      expect(payload, `${label} leaked the member token`).not.toContain(memberSession.token);
      expect(payload, `${label} leaked a token secret`).not.toContain(memberSession.token.split('.')[1] ?? '#');
      expect(payload, `${label} leaked the captcha hash`).not.toContain(captchaHash);
    }

    // The login response body is the smallest envelope there is, and its cookie is the
    // only place the credential may appear.
    const login = await sessionRoute.POST(
      jsonRequest(`${BASE}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    expect(await readJson(login)).toEqual({ data: { ok: true } });
    expect(login.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });

  it('never writes a token, a password or an answer to the error log', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(' '));
    });

    const session = createSession(ensureBootstrapAdmin().id, { userAgent: 'log-sweep' });
    const token = session.token;
    const secret = token.split('.')[1] ?? '';

    // A handler that throws while a live session is attached: the guard logs the
    // failure, and the credential must not be part of it.
    const response = await withAdmin(getRequest('/api/admin/keys', cookieHeader(token)), () => {
      throw new Error('handler exploded');
    });
    expect(response.status).toBe(500);

    // A malformed token must not be echoed either.
    expect(authenticateRequest(getRequest('/api/admin/keys', cookieHeader('garbage')))).toBeNull();
    expect(authenticateRequest(getRequest('/api/admin/keys', cookieHeader(`${token}x`)))).toBeNull();

    const joined = logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain(TEST_MEMBER_PASSWORD);
    expect(joined).not.toContain('scrypt$');
  });
});

describe('boundary: C-TOKEN format change is visible to its consumers', () => {
  it('mints the contract shape and rejects the legacy `<expiresAtMs>.<hmac>` form', async () => {
    const cookie = await signInAsAdmin();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    expect(token).toMatch(CONTRACT_TOKEN_PATTERN);

    const legacy = `${Date.now() + 60_000}.${'a'.repeat(64)}`;
    expect(legacy).not.toMatch(CONTRACT_TOKEN_PATTERN);
    expect(parseSessionToken(legacy)).toBeNull();
    expect(getSessionTokenFromRequest(getRequest('/api/admin/session', cookieHeader(legacy)))).toBe(legacy);
    // Shape parsing keeps the value (the cookie exists), but nothing authenticates it.
    expect(verifySessionToken(legacy)).toBe(false);
    expect(
      (await keysRoute.GET(getRequest('/api/admin/keys', cookieHeader(legacy)))).status,
    ).toBe(401);
  });
});
