import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminSessionRoute from '@/app/api/admin/session/route';
import * as captchaRoute from '@/app/api/auth/captcha/route';
import * as loginRoute from '@/app/api/auth/login/route';
import * as logoutRoute from '@/app/api/auth/logout/route';
import * as passwordRoute from '@/app/api/auth/password/route';
import * as registerRoute from '@/app/api/auth/register/route';
import * as sessionRoute from '@/app/api/auth/session/route';
import { CAPTCHA_MAX_ATTEMPTS, CAPTCHA_TTL_MS, createCaptcha } from '@/lib/captcha';
import { MAX_FAILURES, resetLoginThrottle } from '@/lib/login-throttle';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSession,
  hashSessionSecret,
  listUserSessions,
} from '@/lib/sessions';
import { setRegistrationEnabled } from '@/lib/settings';
import { createUser, findUserByUsername, getUserById } from '@/lib/users';
import type { UserPublic } from '@/lib/types';
import { closeDb, queryOne } from '@/lib/db';
import { TEST_ADMIN_PASSWORD } from '../test-helpers';
import {
  BASE_URL,
  CAPTCHA_ANSWER,
  HARNESS_MEMBER_PASSWORD,
  UNKNOWN_CHALLENGE_ID,
  cookieHeaderFromSetCookie,
  issueCaptcha,
  jsonRequest,
  loginPayload,
  prepareTestEnv,
  readJson,
  readSetCookies,
  registerPayload,
  sessionCookieFor,
  sessionSetCookie,
  sessionTokenFromSetCookie,
  signIn,
} from './harness';

/**
 * C-CAPTCHA / C-AUTH-WIRE: the six `/api/auth/**` handlers.
 *
 * These cases drive the real handlers, the real SQLite store and the real captcha
 * rows - nothing is mocked except the network (there is none). Each acceptance line
 * from the work package has a case here:
 *
 *  - captcha: 200 + `data:image/svg+xml` image;
 *  - register: 201 + HttpOnly/SameSite=Lax cookie, no secret in the body, and
 *    400/403/400 failures that always leave the user table untouched;
 *  - login: admin and member both sign in, and the three credential failures are
 *    byte-identical 401s;
 *  - throttle: shared with register, 429 at the threshold, wrong captchas count;
 *  - session: 200 as a guest (`user:null`) and the `UserPublic` when signed in;
 *  - logout: the row is revoked (the old cookie stops working) and the cookie cleared,
 *    guests included;
 *  - password: other devices die, this one survives.
 */

const MEMBER_PASSWORD = HARNESS_MEMBER_PASSWORD;

interface Envelope<T> {
  data: T;
}

interface SessionData {
  user: UserPublic | null;
  registration: { enabled: boolean };
}

type SessionEnvelope = Envelope<SessionData>;

interface ErrorEnvelopeBody {
  error: { message: string };
}

/** `prepareTestEnv()` + a clean throttle: cases must not inherit each other's budget. */
function resetEnvironment(): void {
  prepareTestEnv();
  resetLoginThrottle();
}

beforeEach(() => {
  resetEnvironment();
});

afterEach(() => {
  resetLoginThrottle();
  closeDb();
});

async function postRegister(body: unknown): Promise<Response> {
  return registerRoute.POST(jsonRequest(`${BASE_URL}/api/auth/register`, { body }));
}

async function postLogin(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return loginRoute.POST(jsonRequest(`${BASE_URL}/api/auth/login`, { body, headers }));
}

async function postLogout(headers: Record<string, string> = {}): Promise<Response> {
  return logoutRoute.POST(jsonRequest(`${BASE_URL}/api/auth/logout`, { method: 'POST', headers }));
}

async function postPassword(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return passwordRoute.POST(jsonRequest(`${BASE_URL}/api/auth/password`, { body, headers }));
}

async function getSession(headers: Record<string, string> = {}): Promise<Response> {
  return sessionRoute.GET(jsonRequest(`${BASE_URL}/api/auth/session`, { method: 'GET', headers }));
}

/** Create a member directly through the store (no route, no captcha needed). */
function seedMember(username = 'seed-member', password = MEMBER_PASSWORD): UserPublic {
  return createUser({ username, password, role: 'member' });
}

describe('GET /api/auth/captcha (C-CAPTCHA)', () => {
  it('answers 200 with the documented challenge envelope', async () => {
    const response = await captchaRoute.GET(
      jsonRequest(`${BASE_URL}/api/auth/captcha`, { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = await readJson<Envelope<Record<string, string>>>(response);
    expect(Object.keys(body.data).sort()).toEqual(['challengeId', 'expiresAt', 'imageDataUrl']);
    expect(body.data.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(String(body.data.imageDataUrl).startsWith('data:image/svg+xml')).toBe(true);
    expect(Number.isNaN(Date.parse(String(body.data.expiresAt)))).toBe(false);
  });

  it('mints a distinct single-use challenge per call', async () => {
    const first = await readJson<Envelope<Record<string, string>>>(
      await captchaRoute.GET(jsonRequest(`${BASE_URL}/api/auth/captcha`, { method: 'GET' })),
    );
    const second = await readJson<Envelope<Record<string, string>>>(
      await captchaRoute.GET(jsonRequest(`${BASE_URL}/api/auth/captcha`, { method: 'GET' })),
    );
    expect(first.data.challengeId).not.toBe(second.data.challengeId);
    expect(first.data.imageDataUrl).not.toBe(second.data.imageDataUrl);
  });

  it('needs no session: a guest gets a challenge', async () => {
    const response = await captchaRoute.GET(
      jsonRequest(`${BASE_URL}/api/auth/captcha`, { method: 'GET' }),
    );
    expect(response.status).toBe(200);
  });
});

describe('POST /api/auth/register (C-AUTH-WIRE)', () => {
  it('answers 201 with an HttpOnly SameSite=Lax cookie for a new member', async () => {
    const response = await postRegister(registerPayload({ username: 'new-member' }));
    expect(response.status).toBe(201);

    const body = await readJson<Envelope<{ user: UserPublic }>>(response);
    expect(body.data.user.username).toBe('new-member');
    expect(body.data.user.role).toBe('member');
    expect(body.data.user.status).toBe('active');
    expect(body.data.user.displayName).toBe('Harness Member');

    const setCookie = sessionSetCookie(response);
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    // Plain HTTP test URL: `Secure` must not be set or the browser would drop the cookie.
    expect(setCookie).not.toContain('Secure');

    // The issued cookie really is a live session for the new account.
    const signedIn = await readJson<SessionEnvelope>(
      await getSession({ cookie: `${SESSION_COOKIE}=${sessionTokenFromSetCookie(setCookie)}` }),
    );
    expect(signedIn.data.user?.username).toBe('new-member');
  });

  it('never returns a password, a hash or a token in the body', async () => {
    const response = await postRegister(registerPayload({ username: 'clean-body' }));
    const raw = await response.text();
    expect(raw).not.toContain(MEMBER_PASSWORD);
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('scrypt$');
    expect(raw).not.toContain('Argon');
    expect(raw).not.toContain('token');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['data']);
    const user = (parsed.data as Record<string, unknown>).user as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual([
      'createdAt',
      'displayName',
      'id',
      'lastLoginAt',
      'role',
      'status',
      'updatedAt',
      'username',
    ]);
  });

  it('sets Secure when the request arrived over https', async () => {
    const response = await registerRoute.POST(
      jsonRequest(`${BASE_URL}/api/auth/register`, {
        body: registerPayload({ username: 'secure-member' }),
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(response.status).toBe(201);
    expect(sessionSetCookie(response)).toContain('Secure');
  });

  it('answers 400 for a missing or wrong captcha, and creates no account', async () => {
    const missing = await postRegister(
      registerPayload({ username: 'no-captcha' }, null),
    );
    expect(missing.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(missing)).error.message).toBe(
      'captcha verification failed',
    );

    const wrong = await postRegister(
      registerPayload({
        username: 'wrong-captcha',
        challengeId: issueCaptcha().challengeId,
        captchaAnswer: 'ZZZZZ',
      }),
    );
    expect(wrong.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(wrong)).error.message).toBe(
      'captcha verification failed',
    );

    const unknownChallenge = await postRegister(
      registerPayload({
        username: 'unknown-captcha',
        challengeId: UNKNOWN_CHALLENGE_ID,
        captchaAnswer: CAPTCHA_ANSWER,
      }),
    );
    expect(unknownChallenge.status).toBe(400);

    for (const username of ['no-captcha', 'wrong-captcha', 'unknown-captcha']) {
      expect(findUserByUsername(username), username).toBeNull();
    }
  });

  it('consumes the challenge: the same captcha cannot register twice', async () => {
    const captcha = issueCaptcha();
    const first = await postRegister(registerPayload({ username: 'one-shot' }, captcha));
    expect(first.status).toBe(201);
    const second = await postRegister(registerPayload({ username: 'one-shot-two' }, captcha));
    expect(second.status).toBe(400);
    expect(findUserByUsername('one-shot-two')).toBeNull();
  });

  it('answers 403 while an admin disabled registration, and creates no account', async () => {
    setRegistrationEnabled(false);
    const response = await postRegister(registerPayload({ username: 'closed-door' }));
    expect(response.status).toBe(403);
    expect(await readJson<ErrorEnvelopeBody>(response)).toEqual({
      error: { message: 'forbidden' },
    });
    expect(findUserByUsername('closed-door')).toBeNull();
    expect(sessionSetCookie(response)).toBeNull();

    // Re-opening takes effect immediately (no cache, no restart).
    setRegistrationEnabled(true);
    const reopened = await postRegister(registerPayload({ username: 'reopened-door' }));
    expect(reopened.status).toBe(201);
  });

  it('does not burn the captcha when registration is closed', async () => {
    setRegistrationEnabled(false);
    const captcha = issueCaptcha();
    const refused = await postRegister(registerPayload({ username: 'turned-away' }, captcha));
    expect(refused.status).toBe(403);
    setRegistrationEnabled(true);
    // The challenge must still verify: the 403 happened before the captcha check.
    const retried = await postRegister(registerPayload({ username: 'turned-away' }, captcha));
    expect(retried.status).toBe(201);
  });

  it('answers 400 for a duplicate username, a weak password and a bad username', async () => {
    seedMember('taken-name');

    const duplicate = await postRegister(
      registerPayload({ username: 'TAKEN-NAME', password: 'Another-Passw0rd' }),
    );
    expect(duplicate.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(duplicate)).error.message).toBe(
      'username is already taken',
    );

    const weak = await postRegister(
      registerPayload({ username: 'weak-password', password: 'short1' }),
    );
    expect(weak.status).toBe(400);
    const weakMessage = (await readJson<ErrorEnvelopeBody>(weak)).error.message;
    expect(weakMessage).toMatch(/at least 8 characters/);

    const containingName = await postRegister(
      registerPayload({ username: 'freddy', password: 'freddy123' }),
    );
    expect(containingName.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(containingName)).error.message).toBe(
      'password must not contain the username',
    );

    const badUsername = await postRegister(registerPayload({ username: 'no spaces allowed' }));
    expect(badUsername.status).toBe(400);

    for (const username of ['weak-password', 'freddy', 'no spaces allowed']) {
      expect(findUserByUsername(username), username).toBeNull();
    }
  });

  it('answers 400 for a malformed body and 413 for an oversized one', async () => {
    const empty = await postRegister('');
    expect(empty.status).toBe(400);

    const notJson = await postRegister('{not json');
    expect(notJson.status).toBe(400);

    const arrayBody = await postRegister('[1,2,3]');
    expect(arrayBody.status).toBe(400);

    const huge = await postRegister({
      username: 'huge-body',
      password: MEMBER_PASSWORD,
      padding: 'x'.repeat(9 * 1024),
    });
    expect(huge.status).toBe(413);
    expect(findUserByUsername('huge-body')).toBeNull();
  });

  it('rejects an oversized field instead of hashing it', async () => {
    const longUsername = await postRegister(
      registerPayload({ username: 'a'.repeat(33), password: MEMBER_PASSWORD }),
    );
    expect(longUsername.status).toBe(400);

    const longPassword = await postRegister(
      registerPayload({ username: 'long-password', password: `Ab1${'x'.repeat(220)}` }),
    );
    expect(longPassword.status).toBe(400);
    expect(findUserByUsername('long-password')).toBeNull();
  });

  it('only ever creates members, never an admin', async () => {
    const created = await readJson<Envelope<{ user: UserPublic }>>(
      await registerRoute.POST(
        jsonRequest(`${BASE_URL}/api/auth/register`, {
          body: { ...registerPayload({ username: 'sneaky-admin' }), role: 'admin' },
        }),
      ),
    );
    expect(created.data.user.role).toBe('member');
  });

  it('refuses the reserved bootstrap name so a signup cannot lock the operator out', async () => {
    // A fresh install has no `users` row yet (the bootstrap row is materialised on the
    // operator's first sign-in) and registration is open by default, so a guest must
    // not be able to claim `admin`: the row would belong to a member and
    // `ensureBootstrapAdmin` would refuse forever.
    const { ensureBootstrapAdmin } = await import('@/lib/users');
    const squatted = await postRegister(
      registerPayload({ username: 'admin', password: 'Guest-Chosen-Passw0rd' }),
    );
    expect(squatted.status).toBe(400);
    // Indistinguishable from any other taken name: the bootstrap state stays private.
    expect(await readJson<ErrorEnvelopeBody>(squatted)).toEqual({
      error: { message: 'username is already taken' },
    });
    expect(sessionSetCookie(squatted)).toBeNull();

    const upperCase = await postRegister(
      registerPayload({ username: 'ADMIN', password: 'Guest-Chosen-Passw0rd' }),
    );
    expect(upperCase.status).toBe(400);
    expect(findUserByUsername('admin')).toBeNull();

    // The operator's bootstrap account is still available afterwards.
    const admin = ensureBootstrapAdmin();
    expect(admin.role).toBe('admin');
    expect(admin.created).toBe(true);
    expect(await readJson<SessionEnvelope>(await getSession(sessionCookieFor(admin.id)))).toEqual({
      data: { user: expect.objectContaining({ username: 'admin', role: 'admin' }), registration: { enabled: true } },
    });
  });
});

describe('POST /api/auth/login (C-AUTH-WIRE)', () => {
  it('signs a member in and returns its UserPublic', async () => {
    const member = seedMember('login-member');
    const response = await postLogin(loginPayload('login-member', MEMBER_PASSWORD));
    expect(response.status).toBe(200);

    const body = await readJson<Envelope<{ user: UserPublic }>>(response);
    expect(body.data.user.id).toBe(member.id);
    expect(body.data.user.username).toBe('login-member');
    expect(body.data.user.role).toBe('member');
    expect(body.data.user.lastLoginAt).not.toBeNull();

    const setCookie = sessionSetCookie(response);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const probe = await readJson<SessionEnvelope>(
      await getSession({ cookie: `${SESSION_COOKIE}=${sessionTokenFromSetCookie(setCookie)}` }),
    );
    expect(probe.data.user?.id).toBe(member.id);
  });

  it('signs the bootstrap admin in', async () => {
    const signedIn = await signIn(loginRoute.POST, 'admin', 'unit-test-admin-password');
    expect(signedIn.response.status).toBe(200);
    expect(signedIn.body.data?.user?.role).toBe('admin');
    expect(signedIn.token).toBeTruthy();
    expect(signedIn.headers.cookie).toContain(`${SESSION_COOKIE}=`);
  });

  it('answers one 401 for a wrong password, unknown user or disabled account', async () => {
    seedMember('known-member', MEMBER_PASSWORD);
    const disabled = seedMember('disabled-member', MEMBER_PASSWORD);
    const { updateUser } = await import('@/lib/users');
    updateUser(disabled.id, { status: 'disabled' });

    const bodies: string[] = [];
    for (const [username, password] of [
      ['known-member', 'Totally-Wrong-Pass1'],
      ['ghost-member', MEMBER_PASSWORD],
      ['disabled-member', MEMBER_PASSWORD],
      ['not a username', MEMBER_PASSWORD],
    ] as const) {
      const response = await postLogin(loginPayload(username, password));
      expect(response.status, username).toBe(401);
      expect(sessionSetCookie(response), username).toBeNull();
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? '') as ErrorEnvelopeBody).toEqual({
      error: { message: 'invalid username or password' },
    });
  });

  it('answers 400 when the captcha is missing or wrong', async () => {
    seedMember('captcha-member');
    const missing = await postLogin(loginPayload('captcha-member', MEMBER_PASSWORD, null));
    expect(missing.status).toBe(400);

    const wrong = await postLogin(
      loginPayload('captcha-member', MEMBER_PASSWORD, {
        challengeId: issueCaptcha().challengeId,
        captchaAnswer: 'ZZZZZ',
      }),
    );
    expect(wrong.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(wrong)).error.message).toBe(
      'captcha verification failed',
    );
    expect(sessionSetCookie(wrong)).toBeNull();
  });

  it('checks the captcha before the credentials (no free password oracle)', async () => {
    seedMember('oracle-member');
    // Correct password, no captcha: the answer must be the captcha 400, never a session.
    const response = await postLogin(loginPayload('oracle-member', MEMBER_PASSWORD, null));
    expect(response.status).toBe(400);
    expect(sessionSetCookie(response)).toBeNull();
  });

  it('consumes the challenge so the same captcha cannot sign in twice', async () => {
    seedMember('replay-member');
    const captcha = issueCaptcha();
    const first = await postLogin(loginPayload('replay-member', MEMBER_PASSWORD, captcha));
    expect(first.status).toBe(200);
    const replay = await postLogin(loginPayload('replay-member', MEMBER_PASSWORD, captcha));
    expect(replay.status).toBe(400);
    expect(sessionSetCookie(replay)).toBeNull();
  });

  it('answers 400 for a malformed body', async () => {
    expect((await postLogin('')).status).toBe(400);
    expect((await postLogin({ username: 'only-a-name' })).status).toBe(400);
    const withoutUsername = await postLogin({
      password: MEMBER_PASSWORD,
      challengeId: 'x',
      captchaAnswer: 'y',
    });
    expect(withoutUsername.status).toBe(400);
  });

  it('never echoes the password or the captcha answer', async () => {
    seedMember('quiet-member');
    const captcha = issueCaptcha();
    const body = await (
      await postLogin(loginPayload('quiet-member', 'Wrong-Passw0rd1', captcha))
    ).text();
    expect(body).not.toContain('Wrong-Passw0rd1');
    expect(body).not.toContain(captcha.challengeId);
    expect(body).not.toContain(captcha.captchaAnswer);
    expect(body).not.toContain('scrypt$');
  });
});

describe('login + register share one throttle (429)', () => {
  it('answers 429 once the shared budget is spent, counting captcha failures', async () => {
    seedMember('budget-member');
    const captcha = issueCaptcha();

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await postLogin(
        loginPayload('budget-member', 'Wrong-Passw0rd1', {
          challengeId: captcha.challengeId,
          captchaAnswer: 'ZZZZZ',
        }),
      );
      expect(response.status, `attempt ${attempt}`).toBe(400);
    }

    // The 31st request is refused before any work is done.
    const throttled = await postLogin(loginPayload('budget-member', MEMBER_PASSWORD));
    expect(throttled.status).toBe(429);
    expect((await readJson<ErrorEnvelopeBody>(throttled)).error.message).toContain(
      'too many failed attempts',
    );
  });

  it('applies the same budget to registration (one fingerprint, one budget)', async () => {
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await postRegister(
        registerPayload({
          username: `throttled-${attempt}`,
          challengeId: issueCaptcha().challengeId,
          captchaAnswer: 'ZZZZZ',
        }),
      );
      expect(response.status, `attempt ${attempt}`).toBe(400);
    }
    // Registration is throttled now, even with a *valid* captcha and a fresh username.
    const throttled = await postRegister(registerPayload({ username: 'throttled-final' }));
    expect(throttled.status).toBe(429);
    expect(findUserByUsername('throttled-final')).toBeNull();
  });

  it('counts a wrong password towards the same budget', async () => {
    seedMember('shared-budget');
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      expect((await postLogin(loginPayload('shared-budget', 'Wrong-Passw0rd1'))).status).toBe(401);
    }
    const blockedRegister = await postRegister(registerPayload({ username: 'after-budget' }));
    expect(blockedRegister.status).toBe(429);
  });

  it('forgets the failures after a successful sign-in', async () => {
    seedMember('forgetful-member');
    for (let attempt = 0; attempt < MAX_FAILURES - 1; attempt += 1) {
      const wrong = await postLogin(loginPayload('forgetful-member', 'Wrong-Passw0rd1'));
      expect(wrong.status).toBe(401);
    }
    expect((await postLogin(loginPayload('forgetful-member', MEMBER_PASSWORD))).status).toBe(200);
    // Budget cleared: a fresh wrong guess is 401 again, not 429.
    const afterReset = await postLogin(loginPayload('forgetful-member', 'Wrong-Passw0rd1'));
    expect(afterReset.status).toBe(401);
  });
});

describe('GET /api/auth/session (C-AUTH-WIRE)', () => {
  it('answers 200 with user:null for a guest (a guest is not an error)', async () => {
    const response = await getSession();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await readJson<SessionEnvelope>(response)).toEqual({
      data: { user: null, registration: { enabled: true } },
    });
  });

  it('answers 200 with user:null for a malformed, unknown or revoked cookie', async () => {
    const member = seedMember('stale-member');
    const revoked = createSession(member.id);
    const { revokeSession } = await import('@/lib/sessions');
    revokeSession(revoked.sessionId);

    for (const cookie of [
      `${SESSION_COOKIE}=garbage`,
      `${SESSION_COOKIE}=${'a'.repeat(32)}.${'b'.repeat(64)}`,
      `${SESSION_COOKIE}=${revoked.token}`,
    ]) {
      const response = await getSession({ cookie });
      expect(response.status, cookie).toBe(200);
      expect((await readJson<SessionEnvelope>(response)).data.user).toBeNull();
    }
  });

  it('returns the UserPublic of the signed-in account', async () => {
    const member = seedMember('session-member');
    const response = await getSession(sessionCookieFor(member.id));
    expect(response.status).toBe(200);
    const body = await readJson<SessionEnvelope>(response);
    expect(body.data.user).toEqual(member);
    expect(body.data.registration).toEqual({ enabled: true });
    // No hash field can appear: `UserPublic` has no slot for one.
    expect(JSON.stringify(body)).not.toContain('scrypt$');
  });

  it('reflects the registration switch without an admin session', async () => {
    setRegistrationEnabled(false);
    expect((await readJson<SessionEnvelope>(await getSession())).data.registration).toEqual({
      enabled: false,
    });
    setRegistrationEnabled(true);
    expect((await readJson<SessionEnvelope>(await getSession())).data.registration).toEqual({
      enabled: true,
    });
  });

  it('reports a deleted account as a guest rather than failing', async () => {
    const member = seedMember('doomed-member');
    const headers = sessionCookieFor(member.id);
    const { deleteUser } = await import('@/lib/users');
    deleteUser(member.id);

    const response = await getSession(headers);
    expect(response.status).toBe(200);
    expect((await readJson<SessionEnvelope>(response)).data.user).toBeNull();
  });
});

describe('POST /api/auth/logout (C-SESSION-STORE)', () => {
  it('revokes the session row and clears the cookie', async () => {
    const member = seedMember('logout-member');
    const headers = sessionCookieFor(member.id);

    const response = await postLogout(headers);
    expect(response.status).toBe(200);
    expect(await readJson<Envelope<{ ok: boolean }>>(response)).toEqual({ data: { ok: true } });

    const setCookie = sessionSetCookie(response);
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');

    // The old cookie must be worthless now - that is what "revoked" means.
    const probe = await getSession(headers);
    expect(probe.status).toBe(200);
    expect((await readJson<SessionEnvelope>(probe)).data.user).toBeNull();
  });

  it('answers 200 for a guest and still clears the cookie', async () => {
    const response = await postLogout();
    expect(response.status).toBe(200);
    expect(await readJson<Envelope<{ ok: boolean }>>(response)).toEqual({ data: { ok: true } });
    expect(sessionSetCookie(response)).toContain('Max-Age=0');
  });

  it('answers 200 for an unknown or already revoked cookie (idempotent)', async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${'a'.repeat(32)}.${'b'.repeat(64)}` };
    expect((await postLogout(headers)).status).toBe(200);
    expect((await postLogout(headers)).status).toBe(200);
  });

  it('signs out only this device', async () => {
    const member = seedMember('two-device-member');
    const desktop = sessionCookieFor(member.id, 'desktop');
    const laptop = sessionCookieFor(member.id, 'laptop');

    expect((await postLogout(desktop)).status).toBe(200);
    const desktopProbe = await readJson<SessionEnvelope>(await getSession(desktop));
    const laptopProbe = await readJson<SessionEnvelope>(await getSession(laptop));
    expect(desktopProbe.data.user).toBeNull();
    expect(laptopProbe.data.user?.id).toBe(member.id);
  });

  it('keeps the Set-Cookie Secure flag aligned with the request scheme', async () => {
    const response = await logoutRoute.POST(
      jsonRequest(`${BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(sessionSetCookie(response)).toContain('Secure');
  });
});

describe('POST /api/auth/password (C-AUTH-WIRE)', () => {
  it('changes the password, keeps this device and revokes every other session', async () => {
    const member = seedMember('rotating-member');
    const current = sessionCookieFor(member.id, 'current-device');
    const other = sessionCookieFor(member.id, 'other-device');

    const response = await postPassword(
      { currentPassword: MEMBER_PASSWORD, newPassword: 'Brand-New-Passw0rd' },
      current,
    );
    expect(response.status).toBe(200);
    expect(await readJson<Envelope<{ ok: boolean }>>(response)).toEqual({ data: { ok: true } });

    // This device is still signed in...
    const currentProbe = await readJson<SessionEnvelope>(await getSession(current));
    expect(currentProbe.data.user?.id).toBe(member.id);
    // ...and every other device is not.
    const otherProbe = await readJson<SessionEnvelope>(await getSession(other));
    expect(otherProbe.data.user).toBeNull();

    // The new password works, the old one does not.
    const newPasswordLogin = await postLogin(
      loginPayload('rotating-member', 'Brand-New-Passw0rd'),
    );
    expect(newPasswordLogin.status).toBe(200);
    expect((await postLogin(loginPayload('rotating-member', MEMBER_PASSWORD))).status).toBe(401);
  });

  it('answers 401 for a guest', async () => {
    const response = await postPassword({
      currentPassword: MEMBER_PASSWORD,
      newPassword: 'Brand-New-Passw0rd',
    });
    expect(response.status).toBe(401);
    expect(await readJson<ErrorEnvelopeBody>(response)).toEqual({
      error: { message: 'unauthorized' },
    });
  });

  it('answers 400 - not 401 - for a wrong current password and keeps the old one', async () => {
    const member = seedMember('wrong-current');
    const headers = sessionCookieFor(member.id);
    const response = await postPassword(
      { currentPassword: 'Not-My-Passw0rd1', newPassword: 'Brand-New-Passw0rd' },
      headers,
    );
    expect(response.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(response)).error.message).toBe(
      'current password is incorrect',
    );
    // Still signed in, and the password did not change.
    expect((await readJson<SessionEnvelope>(await getSession(headers))).data.user?.id).toBe(
      member.id,
    );
    expect((await postLogin(loginPayload('wrong-current', MEMBER_PASSWORD))).status).toBe(200);
  });

  it('answers 400 for a weak new password and leaves the sessions alone', async () => {
    const member = seedMember('weak-new-password');
    const current = sessionCookieFor(member.id, 'current');
    const other = sessionCookieFor(member.id, 'other');

    const response = await postPassword(
      { currentPassword: MEMBER_PASSWORD, newPassword: 'short' },
      current,
    );
    expect(response.status).toBe(400);
    const message = (await readJson<ErrorEnvelopeBody>(response)).error.message;
    expect(message).toMatch(/at least 8 characters/);

    // A rejected change must not sign anything out.
    const otherProbe = await readJson<SessionEnvelope>(await getSession(other));
    expect(otherProbe.data.user?.id).toBe(member.id);
  });

  it('answers 400 for a missing field and 429 while throttled', async () => {
    const member = seedMember('password-body');
    const headers = sessionCookieFor(member.id);
    expect((await postPassword({ newPassword: 'Brand-New-Passw0rd' }, headers)).status).toBe(400);
    expect((await postPassword({ currentPassword: MEMBER_PASSWORD }, headers)).status).toBe(400);

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const response = await postPassword(
        { currentPassword: 'Not-My-Passw0rd1', newPassword: 'Brand-New-Passw0rd' },
        headers,
      );
      expect(response.status, `attempt ${attempt}`).toBe(400);
    }
    const throttled = await postPassword(
      { currentPassword: MEMBER_PASSWORD, newPassword: 'Brand-New-Passw0rd' },
      headers,
    );
    expect(throttled.status).toBe(429);
  });

  it('never echoes a password in the response or on the wire', async () => {
    const member = seedMember('quiet-password');
    const body = await (
      await postPassword(
        { currentPassword: 'Not-My-Passw0rd1', newPassword: 'Brand-New-Passw0rd' },
        sessionCookieFor(member.id),
      )
    ).text();
    expect(body).not.toContain('Not-My-Passw0rd1');
    expect(body).not.toContain('Brand-New-Passw0rd');
    expect(body).not.toContain('scrypt$');
  });
});

describe('cross-cutting: the whole auth surface stays consistent', () => {
  it('register -> session -> logout -> login -> password is one coherent flow', async () => {
    const registered = await postRegister(registerPayload({ username: 'flow-member' }));
    expect(registered.status).toBe(201);
    const issued = cookieHeaderFromSetCookie(sessionSetCookie(registered));
    expect((await readJson<SessionEnvelope>(await getSession(issued))).data.user?.username).toBe(
      'flow-member',
    );

    expect((await postLogout(issued)).status).toBe(200);
    expect((await readJson<SessionEnvelope>(await getSession(issued))).data.user).toBeNull();

    const signedIn = await signIn(loginRoute.POST, 'flow-member', MEMBER_PASSWORD);
    expect(signedIn.response.status).toBe(200);
    const changed = await postPassword(
      { currentPassword: MEMBER_PASSWORD, newPassword: 'Totally-Different-1' },
      signedIn.headers,
    );
    expect(changed.status).toBe(200);
    expect((await getSession(signedIn.headers)).status).toBe(200);
    const user = findUserByUsername('flow-member');
    expect(user).not.toBeNull();
    expect(getUserById(user?.id)).toEqual(user);
  });

  it('every auth route exports only the documented methods', async () => {
    expect(Object.keys(captchaRoute).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    expect(Object.keys(registerRoute).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(Object.keys(loginRoute).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(Object.keys(sessionRoute).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    expect(Object.keys(logoutRoute).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(Object.keys(passwordRoute).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    // Every handler must opt out of caching and run on the Node runtime (node:sqlite).
    const routes = [
      captchaRoute,
      registerRoute,
      loginRoute,
      sessionRoute,
      logoutRoute,
      passwordRoute,
    ];
    for (const route of routes) {
      expect(route.runtime).toBe('nodejs');
      expect(route.dynamic).toBe('force-dynamic');
    }
  });

  it('answers every failure with the {error:{message}} envelope, never a bare string', async () => {
    const failures = [
      await postRegister(registerPayload({ username: 'x' })),
      await postLogin(loginPayload('nobody', 'Wrong-Passw0rd1')),
      await postPassword({}, {}),
      await postRegister(''),
    ];
    for (const response of failures) {
      const body = (await readJson<Record<string, unknown>>(response)) as {
        error?: { message?: unknown };
      };
      expect(response.ok).toBe(false);
      expect(typeof body.error?.message).toBe('string');
      expect((body.error?.message as string).length).toBeGreaterThan(0);
    }
  });

  it('reads Set-Cookie defensively: a cleared cookie yields no Cookie header', () => {
    expect(sessionTokenFromSetCookie(`${SESSION_COOKIE}=; Path=/; Max-Age=0`)).toBe('');
    expect(cookieHeaderFromSetCookie(`${SESSION_COOKIE}=; Path=/; Max-Age=0`)).toEqual({});
    expect(readSetCookies(new Response(null))).toEqual([]);
    expect(sessionSetCookie(new Response(null))).toBeNull();
  });
});

/** Render one `console.*` argument as text without ever throwing on an exotic value. */
function describeLogArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Capture everything the handlers log for the duration of one case.
 *
 * `vi.spyOn` is restored automatically (`restoreMocks: true` in the vitest config),
 * but the explicit `restore()` keeps a mid-test failure from leaking the stub.
 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map(describeLogArgument).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
  ];
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe('C-CAPTCHA: the challenge lifecycle as an HTTP client sees it', () => {
  it('refuses an expired challenge for both sign-in and sign-up', async () => {
    // Minted a TTL ago, so the row is already past `expires_at` but not yet pruned.
    const stale = createCaptcha(Date.now() - CAPTCHA_TTL_MS - 5_000, { answer: CAPTCHA_ANSWER });
    seedMember('expired-captcha-member');

    const login = await postLogin(
      loginPayload('expired-captcha-member', MEMBER_PASSWORD, {
        challengeId: stale.id,
        captchaAnswer: CAPTCHA_ANSWER,
      }),
    );
    expect(login.status).toBe(400);
    expect((await readJson<ErrorEnvelopeBody>(login)).error.message).toBe(
      'captcha verification failed',
    );
    expect(sessionSetCookie(login)).toBeNull();

    const register = await postRegister(
      registerPayload({ username: 'expired-captcha-signup' }, {
        challengeId: stale.id,
        captchaAnswer: CAPTCHA_ANSWER,
      }),
    );
    expect(register.status).toBe(400);
    expect(findUserByUsername('expired-captcha-signup')).toBeNull();
  });

  it('burns the challenge after the documented attempt budget, even for the right answer', async () => {
    seedMember('burned-captcha-member');
    const captcha = issueCaptcha();
    for (let attempt = 0; attempt < CAPTCHA_MAX_ATTEMPTS; attempt += 1) {
      const wrong = await postLogin(
        loginPayload('burned-captcha-member', MEMBER_PASSWORD, {
          challengeId: captcha.challengeId,
          captchaAnswer: 'ZZZZZ',
        }),
      );
      expect(wrong.status, `attempt ${attempt}`).toBe(400);
    }

    // The budget is spent: guessing the glyphs afterwards must not help.
    const right = await postLogin(loginPayload('burned-captcha-member', MEMBER_PASSWORD, captcha));
    expect(right.status).toBe(400);
    expect(sessionSetCookie(right)).toBeNull();
  });

  it('accepts the answer case-insensitively and with surrounding whitespace', async () => {
    seedMember('loose-captcha-member');
    const captcha = issueCaptcha();
    const response = await postLogin(
      loginPayload('loose-captcha-member', MEMBER_PASSWORD, {
        challengeId: captcha.challengeId,
        // `normalizeCaptchaAnswer` trims and upper-cases; the route must not defeat it.
        captchaAnswer: `  ${captcha.captchaAnswer.toLowerCase()}  `,
      }),
    );
    expect(response.status).toBe(200);
    expect(sessionSetCookie(response)).toContain('HttpOnly');
  });

  it('refuses an over-long challenge id or answer at the boundary', async () => {
    seedMember('long-captcha-member');
    const longId = await postLogin(
      loginPayload('long-captcha-member', MEMBER_PASSWORD, {
        challengeId: 'a'.repeat(65),
        captchaAnswer: CAPTCHA_ANSWER,
      }),
    );
    expect(longId.status).toBe(400);

    const longAnswer = await postLogin(
      loginPayload('long-captcha-member', MEMBER_PASSWORD, {
        challengeId: issueCaptcha().challengeId,
        captchaAnswer: 'A'.repeat(17),
      }),
    );
    expect(longAnswer.status).toBe(400);
    expect(sessionSetCookie(longAnswer)).toBeNull();
  });
});

describe('log hygiene: no password, captcha answer or cookie value is ever logged', () => {
  it('captures a real handler log line and records only the failure class', async () => {
    // A missing ADMIN_PASSWORD is the one failing path that does log: bootstrapping the
    // operator account has nothing to hash, and the route reports the class only.
    // This proves the capture below is not vacuously empty.
    delete process.env.ADMIN_PASSWORD;
    seedMember('log-bootstrap-member');
    const captured = captureLogs();
    try {
      const response = await postLogin(loginPayload('admin', 'Wrong-Passw0rd1'));
      expect(response.status).toBe(401);
    } finally {
      captured.restore();
      process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    }

    expect(captured.lines.length).toBeGreaterThan(0);
    expect(captured.lines.join('\n')).toContain('bootstrap admin is not available');
    expect(captured.lines.join('\n')).not.toContain('Wrong-Passw0rd1');
  });

  it('keeps every failure class out of the log while logging no secret', async () => {
    const member = seedMember('log-hygiene-member');
    const captcha = issueCaptcha();
    const liveCookie = sessionCookieFor(member.id);
    const liveToken = liveCookie.cookie?.split('=')[1] ?? '';
    const probePassword = 'Leaky-Passw0rd-Should-Never-Be-Logged';

    const captured = captureLogs();
    try {
      await postRegister(
        registerPayload({
          username: 'log-wrong-captcha',
          challengeId: captcha.challengeId,
          captchaAnswer: 'ZZZZZ',
        }),
      );
      await postRegister(registerPayload({ username: 'log-hygiene-member' }));
      await postRegister(registerPayload({ username: 'log-weak', password: 'short1' }));
      await postRegister('');
      await postLogin(loginPayload('log-hygiene-member', probePassword));
      await postLogin(loginPayload('log-nobody', probePassword));
      await postLogin(loginPayload('log-hygiene-member', MEMBER_PASSWORD, null));
      await postPassword(
        { currentPassword: probePassword, newPassword: 'Brand-New-Passw0rd' },
        liveCookie,
      );
      await postLogout(liveCookie);

      setRegistrationEnabled(false);
      await postRegister(registerPayload({ username: 'log-closed-door' }));
    } finally {
      captured.restore();
    }

    const transcript = captured.lines.join('\n');
    // The secrets the handlers were handed: none of them may appear in a log line.
    for (const secret of [probePassword, MEMBER_PASSWORD, CAPTCHA_ANSWER, captcha.challengeId]) {
      expect(transcript).not.toContain(secret);
    }
    expect(transcript).not.toContain(liveToken);
    expect(transcript).not.toContain(SESSION_COOKIE);
    expect(transcript).not.toContain('scrypt$');
    // A log line that happened at all must talk about the failure class, not the value.
    for (const line of captured.lines) {
      expect(line).not.toMatch(/password[=:]\s*\S/i);
    }
  });
});

describe('concurrency: two requests cannot both win one single-use resource', () => {
  it('creates exactly one account when the same username is registered twice at once', async () => {
    const [first, second] = await Promise.all([
      postRegister(registerPayload({ username: 'race-member' })),
      postRegister(registerPayload({ username: 'race-member' })),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 400]);
    const counted = queryOne<{ rows: number }>(
      'SELECT COUNT(*) AS rows FROM users WHERE username = ?',
      ['race-member'],
    );
    expect(Number(counted?.rows)).toBe(1);

    // The loser gets the documented duplicate answer, never a 500 from a raw UNIQUE fault.
    const loser = first.status === 400 ? first : second;
    expect((await readJson<ErrorEnvelopeBody>(loser)).error.message).toBe(
      'username is already taken',
    );
  });

  it('lets only one of two concurrent sign-ins consume the same captcha', async () => {
    seedMember('race-captcha-member');
    const captcha = issueCaptcha();
    const responses = await Promise.all([
      postLogin(loginPayload('race-captcha-member', MEMBER_PASSWORD, captcha)),
      postLogin(loginPayload('race-captcha-member', MEMBER_PASSWORD, captcha)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(responses.filter((response) => sessionSetCookie(response) !== null)).toHaveLength(1);
  });

  it('keeps concurrent logouts idempotent and never answers 500', async () => {
    const member = seedMember('race-logout-member');
    const headers = sessionCookieFor(member.id);
    const responses = await Promise.all([
      postLogout(headers),
      postLogout(headers),
      postLogout(headers),
    ]);
    for (const [index, response] of responses.entries()) {
      expect(response.status, `logout ${index}`).toBe(200);
      expect(await readJson<Envelope<{ ok: boolean }>>(response)).toEqual({ data: { ok: true } });
      expect(sessionSetCookie(response)).toContain('Max-Age=0');
    }
    expect((await readJson<SessionEnvelope>(await getSession(headers))).data.user).toBeNull();
  });

  it('never fails a session probe that overlaps a logout', async () => {
    const member = seedMember('overlap-member');
    const headers = sessionCookieFor(member.id);
    const responses = await Promise.all([
      getSession(headers),
      postLogout(headers),
      getSession(headers),
      getSession(headers),
    ]);
    // Both interleavings are correct answers; a 401 or a 500 is not.
    for (const [index, response] of responses.entries()) {
      expect(response.status, `response ${index}`).toBe(200);
    }
    expect((await readJson<SessionEnvelope>(await getSession(headers))).data.user).toBeNull();
  });
});

describe('C-TOKEN: the issued credential matches the cookie and storage contract', () => {
  it('marks every credential-bearing response no-store, so a cache cannot replay a cookie', async () => {
    const member = seedMember('cache-member');
    const headers = sessionCookieFor(member.id);
    const responses = [
      await postLogin(loginPayload('cache-member', MEMBER_PASSWORD)),
      await postRegister(registerPayload({ username: 'cache-signup' })),
      await postPassword(
        { currentPassword: MEMBER_PASSWORD, newPassword: 'Brand-New-Passw0rd' },
        headers,
      ),
      await postLogout(headers),
      await getSession(headers),
    ];
    for (const [index, response] of responses.entries()) {
      expect(response.headers.get('cache-control'), `response ${index}`).toBe('no-store');
    }
  });

  it('sets the full attribute set on login and adds Secure over https', async () => {
    seedMember('cookie-member');
    const response = await postLogin(loginPayload('cookie-member', MEMBER_PASSWORD));
    const line = sessionSetCookie(response) ?? '';
    expect(line).toContain(`${SESSION_COOKIE}=`);
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Lax');
    expect(line).toContain('Path=/');
    expect(line).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(line).not.toContain('Secure');

    const secure = await loginRoute.POST(
      jsonRequest(`${BASE_URL}/api/auth/login`, {
        body: loginPayload('cookie-member', MEMBER_PASSWORD),
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(secure.status).toBe(200);
    expect(sessionSetCookie(secure)).toContain('Secure');
  });

  it('stores only sha256(secret) and records the device the session came from', async () => {
    const member = seedMember('device-member');
    const response = await loginRoute.POST(
      jsonRequest(`${BASE_URL}/api/auth/login`, {
        body: loginPayload('device-member', MEMBER_PASSWORD),
        headers: {
          'user-agent': 'vitest-device/1.0',
          'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        },
      }),
    );
    expect(response.status).toBe(200);

    const token = sessionTokenFromSetCookie(sessionSetCookie(response)) ?? '';
    const [sessionId = '', secret = ''] = token.split('.');
    const row = queryOne<{ token_hash: string; user_agent: string | null; ip: string | null }>(
      'SELECT token_hash, user_agent, ip FROM user_sessions WHERE id = ?',
      [sessionId],
    );
    expect(row?.token_hash).toBe(hashSessionSecret(secret));
    expect(String(row?.token_hash)).not.toContain(secret);
    // The device list in the console reads exactly these two columns.
    expect(row?.user_agent).toBe('vitest-device/1.0');
    expect(row?.ip).toBe('203.0.113.9');

    const devices = listUserSessions(member.id);
    expect(devices.map((device) => device.userAgent)).toEqual(['vitest-device/1.0']);
  });
});

describe('the throttle refuses before it burns a captcha, and resets honestly', () => {
  it('does not consume the challenge of a request that was only throttled', async () => {
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const failed = await postLogin(loginPayload('nobody-here', 'Wrong-Passw0rd1'));
      expect(failed.status, `attempt ${attempt}`).toBe(401);
    }

    const captcha = issueCaptcha();
    const throttled = await postRegister(registerPayload({ username: 'after-throttle' }, captcha));
    expect(throttled.status).toBe(429);
    expect(findUserByUsername('after-throttle')).toBeNull();

    // Once the window is cleared the very same challenge must still be usable.
    resetLoginThrottle();
    const retried = await postRegister(registerPayload({ username: 'after-throttle' }, captcha));
    expect(retried.status).toBe(201);
    expect(findUserByUsername('after-throttle')).not.toBeNull();
  });
});

describe('the automation bearer token and the session cookie are the same credential', () => {
  it('accepts a Bearer token for the probe and revokes it on logout', async () => {
    // `scripts/test-api.ps1` cannot hold a cookie jar, so it sends the same token as
    // `Authorization: Bearer`; both paths must resolve to the very same session row.
    const member = seedMember('bearer-member');
    const session = createSession(member.id, { userAgent: 'vitest-bearer' });
    const headers = { authorization: `Bearer ${session.token}` };

    const probe = await readJson<SessionEnvelope>(await getSession(headers));
    expect(probe.data.user?.id).toBe(member.id);

    const loggedOut = await postLogout(headers);
    expect(loggedOut.status).toBe(200);
    expect((await readJson<SessionEnvelope>(await getSession(headers))).data.user).toBeNull();
  });
});

describe('the throttle key is the client fingerprint, as C-AUTH-WIRE promises', () => {
  it('budgets per fingerprint, so one caller cannot exhaust another', async () => {
    seedMember('fingerprint-member');
    const noisy = { 'x-forwarded-for': '198.51.100.7' };
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const failed = await loginRoute.POST(
        jsonRequest(`${BASE_URL}/api/auth/login`, {
          body: loginPayload('fingerprint-member', 'Wrong-Passw0rd1'),
          headers: noisy,
        }),
      );
      expect(failed.status, `attempt ${attempt}`).toBe(401);
    }

    const spent = await loginRoute.POST(
      jsonRequest(`${BASE_URL}/api/auth/login`, {
        body: loginPayload('fingerprint-member', MEMBER_PASSWORD),
        headers: noisy,
      }),
    );
    expect(spent.status).toBe(429);

    // A different fingerprint keeps its own budget: correct credentials still work.
    const elsewhere = await loginRoute.POST(
      jsonRequest(`${BASE_URL}/api/auth/login`, {
        body: loginPayload('fingerprint-member', MEMBER_PASSWORD),
        headers: { 'x-forwarded-for': '198.51.100.8' },
      }),
    );
    expect(elsewhere.status).toBe(200);
    expect(sessionSetCookie(elsewhere)).toContain('HttpOnly');
  });
});

describe('register: the optional displayName stays optional and bounded', () => {
  it('accepts an omitted or blank display name and refuses an oversized one', async () => {
    const omitted = await postRegister(
      registerPayload({ username: 'no-display', displayName: undefined }),
    );
    expect(omitted.status).toBe(201);
    expect((await readJson<Envelope<{ user: UserPublic }>>(omitted)).data.user.displayName).toBeNull();

    const blank = await postRegister(
      registerPayload({ username: 'blank-display', displayName: '   ' }),
    );
    expect(blank.status).toBe(201);
    expect((await readJson<Envelope<{ user: UserPublic }>>(blank)).data.user.displayName).toBeNull();

    const tooLong = await postRegister(
      registerPayload({ username: 'long-display', displayName: 'x'.repeat(65) }),
    );
    expect(tooLong.status).toBe(400);
    expect(findUserByUsername('long-display')).toBeNull();

    // Far past the field budget but still inside the 8 KiB body budget: a field
    // rejection, not a body-size rejection, and never a 500.
    const absurd = await postRegister(
      registerPayload({ username: 'absurd-display', displayName: 'x'.repeat(1000) }),
    );
    expect(absurd.status).toBe(400);
    expect(findUserByUsername('absurd-display')).toBeNull();

    const wrongType = await postRegister(
      registerPayload({ username: 'typed-display', displayName: 42 as unknown as string }),
    );
    expect(wrongType.status).toBe(400);
  });

  it('strips control characters instead of storing them', async () => {
    const response = await postRegister(
      registerPayload({ username: 'control-display', displayName: 'Harness\u0000 Member' }),
    );
    expect(response.status).toBe(201);
    const stored = (await readJson<Envelope<{ user: UserPublic }>>(response)).data.user.displayName;
    expect(stored).toBe('Harness Member');
  });
});

describe('a session dies with the account, not with the cookie', () => {
  it('reports a disabled account as a guest and refuses its password change', async () => {
    const member = seedMember('disabled-live-member');
    const headers = sessionCookieFor(member.id);
    const { updateUser } = await import('@/lib/users');
    updateUser(member.id, { status: 'disabled' });

    // A disabled owner is a guest, but the probe itself is still a normal 200.
    const probe = await getSession(headers);
    expect(probe.status).toBe(200);
    expect((await readJson<SessionEnvelope>(probe)).data.user).toBeNull();

    const change = await postPassword(
      { currentPassword: MEMBER_PASSWORD, newPassword: 'Brand-New-Passw0rd' },
      headers,
    );
    expect(change.status).toBe(401);
  });
});

describe('the automation entry point at /api/admin/session stays captcha-free', () => {
  it('signs the operator in with the password alone', async () => {
    // `scripts/test-api.ps1` and the CI smoke tests post exactly `{password}`.
    const response = await adminSessionRoute.POST(
      jsonRequest(`${BASE_URL}/api/admin/session`, { body: { password: TEST_ADMIN_PASSWORD } }),
    );
    expect(response.status).toBe(200);
    const line = sessionSetCookie(response);
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Lax');

    const probe = await adminSessionRoute.GET(
      jsonRequest(`${BASE_URL}/api/admin/session`, {
        method: 'GET',
        headers: cookieHeaderFromSetCookie(line),
      }),
    );
    expect(probe.status).toBe(200);
  });

  it('still answers 401 for a wrong password and 403 for a member credential', async () => {
    const wrong = await adminSessionRoute.POST(
      jsonRequest(`${BASE_URL}/api/admin/session`, { body: { password: 'Not-The-Passw0rd' } }),
    );
    expect(wrong.status).toBe(401);

    seedMember('member-at-admin-door');
    const member = await adminSessionRoute.POST(
      jsonRequest(`${BASE_URL}/api/admin/session`, {
        body: { username: 'member-at-admin-door', password: MEMBER_PASSWORD },
      }),
    );
    expect(member.status).toBe(403);
    expect(sessionSetCookie(member)).toBeNull();
  });
});
