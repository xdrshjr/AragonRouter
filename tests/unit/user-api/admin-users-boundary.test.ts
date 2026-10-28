import { beforeEach, describe, expect, it } from 'vitest';
import * as authSessionRoute from '@/app/api/auth/session/route';
import * as loginRoute from '@/app/api/auth/login/route';
import { authenticateSessionToken } from '@/lib/sessions';
import { REGISTRATION_ENABLED_KEY } from '@/lib/types';
import type { UserDetailPublic, UserPublic } from '@/lib/types';
import { isRegistrationEnabled, readSetting } from '@/lib/settings';
import { authenticateUser, countActiveAdmins } from '@/lib/users';
import {
  TEST_ADMIN_PASSWORD,
  TEST_MEMBER_PASSWORD,
  jsonRequest,
  prepareTestEnv,
} from '../test-helpers';
import { loginPayload } from './harness';
import {
  SETTINGS_KEYS,
  USER_PUBLIC_KEYS,
  USER_SESSION_KEYS,
  callAdmin,
  createAdminAccount,
  createMemberAccount,
  seedUsers,
  signInAdmin,
  signInAs,
  uniqueUsername,
  type SignedIn,
} from './admin-harness';

/**
 * Admin users/settings at its *edges*: the places where this work package touches
 * another module (`lib/users`, `lib/sessions`, `lib/settings`, `/api/auth/**`) and
 * the places where "it works" is not the same as "it is safe".
 *
 * Kept separate from `admin-users.test.ts` (the happy-path contract suite) so the
 * boundary list can be read on its own:
 *
 *  1. envelope discipline - a write endpoint never answers non-JSON, never 2xx on a
 *     malformed body, never writes anything on a 400;
 *  2. credential hygiene - no password hash, no scrypt digest, no session secret on
 *     any response, success or failure;
 *  3. idempotency - reset twice, revoke twice, disable twice, re-enable after a
 *     revoke (the dangerous direction: does the killed cookie come back?);
 *  4. races - the same session revoked by two concurrent requests, two accounts
 *     reset concurrently (no cross-revocation);
 *  5. non-disclosure - a foreign session id, an unknown one and a malformed one are
 *     answered identically, and a 404 never confirms anything else;
 *  6. pagination bounds - the default limit, the 100 clamp, search over displayName;
 *  7. the settings switch as a cross-package producer - `/api/auth/session` and
 *     `/api/auth/login` see the write immediately, and closing registration does not
 *     disturb sessions that already exist;
 *  8. guard precision - revoked cookie (401, not 403), disabled admin (401),
 *     promoted member (200 without a new cookie), demoted admin (403), bearer form;
 *  9. rule messages - 400 with a sentence an administrator can read, and the
 *     instance stays administrable after every refusal.
 */

interface DataBody<T> {
  data: T;
}

interface ErrorBody {
  error: { message: string };
}

const ADMIN_USERS = '/api/admin/users';
const ADMIN_SETTINGS = '/api/admin/settings';

/**
 * Passwords that satisfy the policy *and* contain no fragment of any fixture
 * username. `validatePasswordStrength` refuses a password that contains a piece of
 * its owner's name, so a fixture like `Idem-First-Pass9` for `idem-reset` would be
 * rejected as "contains the username" and prove nothing about the reset path.
 */
const STRONG_A = 'Glacier-Vault-9';
const STRONG_B = 'Trombone-Quartz-9';

beforeEach(() => {
  prepareTestEnv();
});

async function json<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

async function text(response: Response): Promise<string> {
  return response.text();
}

function resetPassword(id: string, password: string, headers: Record<string, string>) {
  return callAdmin(`${ADMIN_USERS}/${id}/password`, {
    method: 'POST',
    body: { password },
    headers,
  });
}

function revokeSession(id: string, sessionId: string, headers: Record<string, string>) {
  return callAdmin(`${ADMIN_USERS}/${id}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers,
  });
}

function setRegistration(enabled: boolean, headers: Record<string, string>) {
  return callAdmin(ADMIN_SETTINGS, {
    method: 'PATCH',
    body: { registration: { enabled } },
    headers,
  });
}

/** Which users exist, so a rejected write can be proved to have written nothing. */
async function usernames(headers: Record<string, string>): Promise<string[]> {
  const response = await callAdmin(`${ADMIN_USERS}?limit=100`, { headers });
  const body = await json<{ data: UserPublic[] }>(response);
  return body.data.map((user) => user.username).sort();
}

describe('write endpoints: malformed bodies are 400 with the C4 envelope and no side effect', () => {
  it('refuses a non-object JSON body on all four write endpoints', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('edge-body-member');
    const before = await usernames(admin.headers);

    const targets: { name: string; path: string; method: 'POST' | 'PATCH' }[] = [
      { name: 'POST /users', path: ADMIN_USERS, method: 'POST' },
      { name: 'PATCH /users/[id]', path: `${ADMIN_USERS}/${member.id}`, method: 'PATCH' },
      {
        name: 'POST /users/[id]/password',
        path: `${ADMIN_USERS}/${member.id}/password`,
        method: 'POST',
      },
      { name: 'PATCH /settings', path: ADMIN_SETTINGS, method: 'PATCH' },
    ];
    const bodies = ['"a bare string"', '[1, 2, 3]', '42', 'null', '   ', '{ broken'];

    for (const target of targets) {
      for (const body of bodies) {
        const response = await callAdmin(target.path, {
          method: target.method,
          body,
          headers: admin.headers,
        });
        const label = `${target.name} <- ${body}`;
        expect(response.status, label).toBe(400);
        expect(response.headers.get('content-type'), label).toContain('application/json');
        expect(response.headers.get('cache-control'), label).toBe('no-store');
        const payload = await json<ErrorBody>(response);
        expect(Object.keys(payload), label).toEqual(['error']);
        expect(payload.error.message.length, label).toBeGreaterThan(0);
        expect(Object.keys(payload.error), label).toEqual(['message']);
      }
    }

    // Not one of those requests created, renamed or deleted anything.
    expect(await usernames(admin.headers)).toEqual(before);
    expect((await callAdmin(`${ADMIN_USERS}/${member.id}`, { headers: admin.headers })).status)
      .toBe(200);
    expect(isRegistrationEnabled()).toBe(true);
  });

  it('answers 413 for a body that exceeds the request budget on every write endpoint', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('edge-oversize');
    // `content-length` is the documented fast path the parser checks before reading.
    const oversized = { 'content-length': String(64 * 1024 * 1024) };

    for (const target of [
      { path: ADMIN_USERS, method: 'POST' as const },
      { path: `${ADMIN_USERS}/${member.id}`, method: 'PATCH' as const },
      { path: `${ADMIN_USERS}/${member.id}/password`, method: 'POST' as const },
      { path: ADMIN_SETTINGS, method: 'PATCH' as const },
    ]) {
      const response = await callAdmin(target.path, {
        method: target.method,
        body: { username: 'nope', password: TEST_MEMBER_PASSWORD },
        headers: { ...admin.headers, ...oversized },
      });
      expect(response.status, target.path).toBe(413);
      expect((await json<ErrorBody>(response)).error.message).toContain('too large');
    }
    expect(await usernames(admin.headers)).toEqual(['admin', 'edge-oversize']);
  });

  it('keeps the exact success shapes and never answers 2xx with an empty body', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('edge-shape');
    const responses: { name: string; response: Response; inspect: (body: unknown) => void }[] = [];

    responses.push({
      name: 'list',
      response: await callAdmin(ADMIN_USERS, { headers: admin.headers }),
      inspect: (body) => expect(Object.keys(body as object).sort()).toEqual(['data', 'nextCursor']),
    });
    responses.push({
      name: 'create',
      response: await callAdmin(ADMIN_USERS, {
        method: 'POST',
        body: { username: 'edge-shape-created', password: TEST_MEMBER_PASSWORD },
        headers: admin.headers,
      }),
      inspect: (body) =>
        expect(Object.keys((body as DataBody<UserPublic>).data).sort()).toEqual(USER_PUBLIC_KEYS),
    });
    responses.push({
      name: 'detail',
      response: await callAdmin(`${ADMIN_USERS}/${member.id}`, { headers: admin.headers }),
      inspect: (body) => {
        const detail = (body as DataBody<UserDetailPublic>).data;
        expect(Object.keys(detail).sort()).toEqual([...USER_PUBLIC_KEYS, 'sessions'].sort());
        for (const session of detail.sessions) {
          expect(Object.keys(session).sort()).toEqual(USER_SESSION_KEYS);
        }
      },
    });
    responses.push({
      name: 'patch',
      response: await callAdmin(`${ADMIN_USERS}/${member.id}`, {
        method: 'PATCH',
        body: { displayName: 'Edge Shape' },
        headers: admin.headers,
      }),
      inspect: (body) =>
        expect(Object.keys((body as DataBody<UserPublic>).data).sort()).toEqual(USER_PUBLIC_KEYS),
    });
    responses.push({
      name: 'reset',
      response: await resetPassword(member.id, STRONG_A, admin.headers),
      inspect: (body) => expect(body).toEqual({ data: { ok: true } }),
    });
    responses.push({
      name: 'settings get',
      response: await callAdmin(ADMIN_SETTINGS, { headers: admin.headers }),
      inspect: (body) =>
        expect(Object.keys((body as DataBody<object>).data).sort()).toEqual(SETTINGS_KEYS),
    });
    responses.push({
      name: 'settings patch',
      response: await setRegistration(false, admin.headers),
      inspect: (body) =>
        expect(body).toEqual({ data: { registration: { enabled: false } } }),
    });
    responses.push({
      name: 'delete',
      response: await callAdmin(`${ADMIN_USERS}/${member.id}`, {
        method: 'DELETE',
        headers: admin.headers,
      }),
      inspect: (body) => expect(body).toEqual({ data: { ok: true } }),
    });

    for (const { name, response, inspect } of responses) {
      expect([200, 201], name).toContain(response.status);
      expect(response.headers.get('content-type'), name).toContain('application/json');
      const raw = await text(response);
      expect(raw.length, name).toBeGreaterThan(0);
      inspect(JSON.parse(raw));
    }
  });
});

describe('credential hygiene: nothing secret leaves any endpoint', () => {
  const FORBIDDEN = [
    'password_hash',
    'passwordHash',
    'scrypt$',
    'token_hash',
    'tokenHash',
    'set-cookie',
  ];

  it('never emits a hash, a digest or another account password on success or failure', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('hygiene-member');
    const device = signInAs(member.id, 'hygiene-device');
    const secretHalf = device.token.split('.')[1] ?? 'missing-secret';
    const newPassword = STRONG_A;

    const responses: [string, Response][] = [
      ['list', await callAdmin(`${ADMIN_USERS}?search=hygiene`, { headers: admin.headers })],
      ['detail', await callAdmin(`${ADMIN_USERS}/${member.id}`, { headers: admin.headers })],
      ['create-ok', await callAdmin(ADMIN_USERS, {
        method: 'POST',
        body: { username: 'hygiene-created', password: TEST_MEMBER_PASSWORD },
        headers: admin.headers,
      })],
      ['create-dup', await callAdmin(ADMIN_USERS, {
        method: 'POST',
        body: { username: 'hygiene-member', password: TEST_MEMBER_PASSWORD },
        headers: admin.headers,
      })],
      ['patch', await callAdmin(`${ADMIN_USERS}/${member.id}`, {
        method: 'PATCH',
        body: { displayName: 'Hygiene' },
        headers: admin.headers,
      })],
      ['patch-bad', await callAdmin(`${ADMIN_USERS}/${member.id}`, {
        method: 'PATCH',
        body: { role: 'root' },
        headers: admin.headers,
      })],
      ['reset', await resetPassword(member.id, newPassword, admin.headers)],
      ['reset-weak', await resetPassword(member.id, 'weak', admin.headers)],
      ['revoke', await revokeSession(member.id, device.sessionId, admin.headers)],
      ['revoke-unknown', await revokeSession(member.id, 'f'.repeat(32), admin.headers)],
      ['settings', await callAdmin(ADMIN_SETTINGS, { headers: admin.headers })],
      ['settings-bad', await callAdmin(ADMIN_SETTINGS, {
        method: 'PATCH',
        body: { registration: { enabled: 'yes' } },
        headers: admin.headers,
      })],
      ['delete-unknown', await callAdmin(`${ADMIN_USERS}/nobody-at-all`, {
        method: 'DELETE',
        headers: admin.headers,
      })],
    ];

    for (const [label, response] of responses) {
      const raw = await text(response);
      for (const needle of FORBIDDEN) {
        expect(raw, `${label} leaked ${needle}`).not.toContain(needle);
      }
      expect(raw, `${label} leaked a session secret`).not.toContain(secretHalf);
      expect(raw, `${label} leaked the old password`).not.toContain(TEST_MEMBER_PASSWORD);
      expect(raw, `${label} leaked the new password`).not.toContain(newPassword);
      expect(raw, `${label} leaked the admin password`).not.toContain(TEST_ADMIN_PASSWORD);
    }
  });

  it('logs a 401/403 without echoing the cookie it could not use', async () => {
    // A shape-valid but unknown session: the guard fails, and the token must not
    // travel back in the body.
    const forged = `${'a'.repeat(32)}.${'b'.repeat(64)}`;
    const response = await callAdmin(ADMIN_USERS, { headers: { cookie: `aragon_session=${forged}` } });
    expect(response.status).toBe(401);
    const raw = await text(response);
    expect(raw).not.toContain(forged);
    expect(raw).not.toContain('b'.repeat(64));
    expect(JSON.parse(raw)).toEqual({ error: { message: 'unauthorized' } });
  });
});

describe('idempotency: repeating a write converges instead of drifting', () => {
  it('treats a second password reset as a fresh reset, not an error', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('idem-reset');

    expect((await resetPassword(member.id, STRONG_A, admin.headers)).status).toBe(200);
    const second = await resetPassword(member.id, STRONG_B, admin.headers);
    expect(second.status).toBe(200);
    expect(await json<unknown>(second)).toEqual({ data: { ok: true } });

    expect(authenticateUser('idem-reset', STRONG_B)).not.toBeNull();
    expect(authenticateUser('idem-reset', STRONG_A)).toBeNull();
    expect(authenticateUser('idem-reset', TEST_MEMBER_PASSWORD)).toBeNull();
  });

  it('answers ok when the session was already killed by a password reset', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('idem-revoke');
    const killed = signInAs(member.id, 'idem-device-1');
    const survivor = signInAs(member.id, 'idem-device-2');

    expect((await resetPassword(member.id, STRONG_A, admin.headers)).status).toBe(200);
    expect(authenticateSessionToken(killed.token)).toBeNull();

    // Already revoked by the reset: revoking by id again still converges on "it is dead".
    const again = await revokeSession(member.id, killed.sessionId, admin.headers);
    expect(again.status).toBe(200);
    expect(await json<unknown>(again)).toEqual({ data: { ok: true } });
    expect(authenticateSessionToken(killed.token)).toBeNull();
    // The survivor had *also* been killed by the reset - and is not resurrected.
    expect(authenticateSessionToken(survivor.token)).toBeNull();
  });

  it('disabling twice is harmless and never re-opens the account', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('idem-disable');
    const device = signInAs(member.id, 'idem-disable-device');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await callAdmin(`${ADMIN_USERS}/${member.id}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
        headers: admin.headers,
      });
      expect(response.status, `attempt ${attempt}`).toBe(200);
      expect((await json<DataBody<UserPublic>>(response)).data.status).toBe('disabled');
      expect(authenticateSessionToken(device.token)).toBeNull();
    }
    expect(authenticateUser('idem-disable', TEST_MEMBER_PASSWORD)).toBeNull();
  });

  it('does not resurrect a revoked session when the account is re-enabled', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('idem-reenable');
    const device = signInAs(member.id, 'idem-reenable-device');

    const disabled = await callAdmin(`${ADMIN_USERS}/${member.id}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
      headers: admin.headers,
    });
    expect(disabled.status).toBe(200);
    expect(authenticateSessionToken(device.token)).toBeNull();

    const reEnabled = await callAdmin(`${ADMIN_USERS}/${member.id}`, {
      method: 'PATCH',
      body: { status: 'active' },
      headers: admin.headers,
    });
    expect(reEnabled.status).toBe(200);
    expect((await json<DataBody<UserPublic>>(reEnabled)).data.status).toBe('active');
    // The revoked row must stay revoked: re-activation is not a session restore.
    expect(authenticateSessionToken(device.token)).toBeNull();
    const detail = await callAdmin(`${ADMIN_USERS}/${member.id}`, { headers: admin.headers });
    expect((await json<DataBody<UserDetailPublic>>(detail)).data.sessions).toEqual([]);
    // A fresh sign-in is the only way back in.
    expect(authenticateUser('idem-reenable', TEST_MEMBER_PASSWORD)).not.toBeNull();
  });

  it('reports a second delete as a plain 404 with the same body as an invented id', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('idem-delete');

    expect((await callAdmin(`${ADMIN_USERS}/${member.id}`, {
      method: 'DELETE',
      headers: admin.headers,
    })).status).toBe(200);

    const second = await callAdmin(`${ADMIN_USERS}/${member.id}`, {
      method: 'DELETE',
      headers: admin.headers,
    });
    const invented = await callAdmin(`${ADMIN_USERS}/never-existed`, {
      method: 'DELETE',
      headers: admin.headers,
    });
    expect(second.status).toBe(404);
    expect(await text(second)).toBe(await text(invented));
  });
});

describe('races: concurrent admin writes stay consistent', () => {
  it('safely revokes one session through two concurrent requests', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('race-revoke');
    const doomed = signInAs(member.id, 'race-doomed');
    const survivor = signInAs(member.id, 'race-survivor');

    const [first, second] = await Promise.all([
      revokeSession(member.id, doomed.sessionId, admin.headers),
      revokeSession(member.id, doomed.sessionId, admin.headers),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    for (const response of [first, second]) {
      expect(await json<unknown>(response)).toEqual({ data: { ok: true } });
    }
    expect(authenticateSessionToken(doomed.token)).toBeNull();
    expect(authenticateSessionToken(survivor.token)).not.toBeNull();
  });

  it('keeps two concurrent password resets on their own accounts', async () => {
    const admin = signInAdmin();
    const first = createMemberAccount('race-a');
    const second = createMemberAccount('race-b');
    const firstDevice = signInAs(first.id, 'race-a-device');
    const secondDevice = signInAs(second.id, 'race-b-device');
    const bystander = createMemberAccount('race-c');
    const bystanderDevice = signInAs(bystander.id, 'race-c-device');

    const [a, b] = await Promise.all([
      resetPassword(first.id, STRONG_A, admin.headers),
      resetPassword(second.id, STRONG_B, admin.headers),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    // Each reset hit its own target, and only its own sessions.
    expect(authenticateSessionToken(firstDevice.token)).toBeNull();
    expect(authenticateSessionToken(secondDevice.token)).toBeNull();
    expect(authenticateUser('race-a', STRONG_A)).not.toBeNull();
    expect(authenticateUser('race-b', STRONG_B)).not.toBeNull();
    expect(authenticateUser('race-b', STRONG_A)).toBeNull();
    expect(authenticateUser('race-a', STRONG_B)).toBeNull();
    expect(authenticateSessionToken(bystanderDevice.token)).not.toBeNull();
    expect(authenticateSessionToken(admin.token)).not.toBeNull();
  });

  it('lets only one of two concurrent self-lockout attempts matter (both refused)', async () => {
    const admin = signInAdmin();
    const [a, b] = await Promise.all([
      callAdmin(`${ADMIN_USERS}/${admin.userId}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
        headers: admin.headers,
      }),
      callAdmin(`${ADMIN_USERS}/${admin.userId}`, {
        method: 'PATCH',
        body: { role: 'member' },
        headers: admin.headers,
      }),
    ]);
    expect([a.status, b.status]).toEqual([400, 400]);
    expect(countActiveAdmins()).toBe(1);
    expect(authenticateSessionToken(admin.token)).not.toBeNull();
    expect((await callAdmin(ADMIN_USERS, { headers: admin.headers })).status).toBe(200);
  });
});

describe('non-disclosure: a 404 confirms nothing beyond the ids in the path', () => {
  it('answers a foreign, an unknown and a malformed session id identically', async () => {
    const admin = signInAdmin();
    const owner = createMemberAccount('leak-owner');
    const stranger = createMemberAccount('leak-stranger');
    const strangerDevice = signInAs(stranger.id, 'leak-stranger-device');

    const probes = [
      strangerDevice.sessionId, // exists, but belongs to somebody else
      '0'.repeat(32), // well-formed, unknown
      'not-a-session-id', // malformed
      encodeURIComponent('../../etc/passwd'),
    ];
    const bodies: string[] = [];
    for (const probe of probes) {
      const response = await revokeSession(owner.id, probe, admin.headers);
      expect(response.status, probe).toBe(404);
      bodies.push(await text(response));
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    // Same bytes for all four: no "forbidden", no "wrong owner", no echo of the id.
    expect(new Set(bodies).size).toBe(1);
    const only = JSON.parse(bodies[0] ?? '{}') as ErrorBody;
    expect(only).toEqual({ error: { message: 'session not found' } });
    for (const probe of probes) expect(bodies[0], probe).not.toContain(probe);

    // And the cross-user attempt really did nothing.
    expect(authenticateSessionToken(strangerDevice.token)).not.toBeNull();
  });

  it('refuses an unknown user before touching any session, and leaves it alive', async () => {
    const admin = signInAdmin();
    const stranger = createMemberAccount('leak-stranger-2');
    const strangerDevice = signInAs(stranger.id, 'leak-stranger-2-device');

    const response = await revokeSession('missing-user', strangerDevice.sessionId, admin.headers);
    expect(response.status).toBe(404);
    expect(await json<ErrorBody>(response)).toEqual({ error: { message: 'user not found' } });
    // A caller holding two unrelated ids must not be able to revoke anything.
    expect(authenticateSessionToken(strangerDevice.token)).not.toBeNull();
  });

  it('keeps the settings and user errors free of internal detail', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('leak-messages');
    const bodies = await Promise.all([
      json<ErrorBody>(await callAdmin(`${ADMIN_USERS}?role=root`, { headers: admin.headers })),
      json<ErrorBody>(await callAdmin(`${ADMIN_USERS}?status=nope`, { headers: admin.headers })),
      json<ErrorBody>(await callAdmin(ADMIN_SETTINGS, {
        method: 'PATCH',
        body: {},
        headers: admin.headers,
      })),
      json<ErrorBody>(await callAdmin(`${ADMIN_USERS}/${member.id}`, {
        method: 'PATCH',
        body: { role: null },
        headers: admin.headers,
      })),
    ]);
    for (const body of bodies) {
      const message = body.error.message;
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThan(200);
      expect(message).not.toMatch(/Error:|TypeError|at [\w.]+\s*\(/);
      expect(message).not.toMatch(/[A-Za-z]:\\|\/src\/|node_modules/);
      expect(message).not.toContain('\n');
    }
  });
});

describe('pagination bounds: default limit, the 100 clamp and search scope', () => {
  it('falls back to the documented default when limit is absent or unparsable', async () => {
    const admin = signInAdmin();
    // 30 rows + the bootstrap admin: more than the default page but below the cap.
    seedUsers(30, { prefix: 'default-lim' });

    for (const query of ['', '?limit=', '?limit=abc', '?limit=0', '?limit=-5']) {
      const response = await callAdmin(`${ADMIN_USERS}${query}`, { headers: admin.headers });
      expect(response.status, query).toBe(200);
      const body = await json<{ data: UserPublic[]; nextCursor: string | null }>(response);
      expect(body.data.length, query).toBe(20);
      expect(body.nextCursor, query).not.toBeNull();
    }
  });

  it('accepts exactly 100 and clamps anything larger to 100', async () => {
    const admin = signInAdmin();
    seedUsers(120, { prefix: 'clamp-lim' });

    for (const query of ['?limit=100', '?limit=101', '?limit=999999', '?limit=1000']) {
      const response = await callAdmin(`${ADMIN_USERS}${query}`, { headers: admin.headers });
      expect(response.status, query).toBe(200);
      const body = await json<{ data: UserPublic[]; nextCursor: string | null }>(response);
      expect(body.data.length, query).toBe(100);
      expect(body.nextCursor, query).not.toBeNull();
    }

    // The cap is a page size, not a truncation: the rest is still reachable.
    const first = await json<{ data: UserPublic[]; nextCursor: string | null }>(
      await callAdmin(`${ADMIN_USERS}?limit=100`, { headers: admin.headers }),
    );
    const rest = await json<{ data: UserPublic[]; nextCursor: string | null }>(
      await callAdmin(
        `${ADMIN_USERS}?limit=100&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        { headers: admin.headers },
      ),
    );
    expect(rest.data.length).toBe(21);
    expect(rest.nextCursor).toBeNull();
  });

  it('searches the display name as well as the username, and nothing else', async () => {
    const admin = signInAdmin();
    createMemberAccount('scope-username');
    const described = createMemberAccount('scope-unrelated');
    await callAdmin(`${ADMIN_USERS}/${described.id}`, {
      method: 'PATCH',
      body: { displayName: 'Zebra Operator' },
      headers: admin.headers,
    });

    const byName = await json<{ data: UserPublic[] }>(
      await callAdmin(`${ADMIN_USERS}?search=zebra`, { headers: admin.headers }),
    );
    expect(byName.data.map((user) => user.username)).toEqual(['scope-unrelated']);

    // A password, a role or an id must never become a search oracle.
    for (const query of [
      encodeURIComponent(TEST_MEMBER_PASSWORD),
      encodeURIComponent(described.id),
      'active',
    ]) {
      const response = await callAdmin(`${ADMIN_USERS}?search=${query}`, { headers: admin.headers });
      expect(response.status, query).toBe(200);
      const body = await json<{ data: UserPublic[] }>(response);
      expect(body.data, query).toEqual([]);
    }
  });
});

describe('registration switch: cross-package producer/consumer behaviour', () => {
  it('persists the switch in the settings row, not in memory', async () => {
    const admin = signInAdmin();
    expect(readSetting(REGISTRATION_ENABLED_KEY)).toBeNull();
    expect((await setRegistration(false, admin.headers)).status).toBe(200);
    expect(readSetting(REGISTRATION_ENABLED_KEY)).toBe('0');
    expect((await setRegistration(true, admin.headers)).status).toBe(200);
    expect(readSetting(REGISTRATION_ENABLED_KEY)).toBe('1');
    expect(isRegistrationEnabled()).toBe(true);
  });

  it('is visible to /api/auth/session for a guest in the same request cycle', async () => {
    const admin = signInAdmin();
    expect((await setRegistration(false, admin.headers)).status).toBe(200);

    const asGuest = await json<DataBody<{ user: UserPublic | null; registration: { enabled: boolean } }>>(
      await authSessionRoute.GET(jsonRequest('http://localhost/api/auth/session', { method: 'GET' })),
    );
    expect(asGuest.data.user).toBeNull();
    expect(asGuest.data.registration).toEqual({ enabled: false });

    expect((await setRegistration(true, admin.headers)).status).toBe(200);
    const reopened = await json<DataBody<{ registration: { enabled: boolean } }>>(
      await authSessionRoute.GET(jsonRequest('http://localhost/api/auth/session', { method: 'GET' })),
    );
    expect(reopened.data.registration).toEqual({ enabled: true });
  });

  it('suspends sign-ups without disturbing sessions or sign-ins that already exist', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('switch-member');
    const device = signInAs(member.id, 'switch-device');

    expect((await setRegistration(false, admin.headers)).status).toBe(200);

    // Existing credentials keep working: the switch closes registration, not the door.
    expect(authenticateSessionToken(device.token)).not.toBeNull();
    expect((await callAdmin(ADMIN_USERS, { headers: admin.headers })).status).toBe(200);

    const signIn = await loginRoute.POST(
      jsonRequest('http://localhost/api/auth/login', {
        body: loginPayload('switch-member', TEST_MEMBER_PASSWORD),
      }),
    );
    expect(signIn.status).toBe(200);
    const signedInBody = await json<DataBody<{ user: UserPublic }>>(signIn);
    expect(signedInBody.data.user.username).toBe('switch-member');
    // A login minted while registration is closed is a real, usable session.
    const minted = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const mintedToken = minted.slice(minted.indexOf('=') + 1);
    expect(authenticateSessionToken(mintedToken)).not.toBeNull();
  });

  it('rejects a body that carries the flag in the wrong place and writes nothing', async () => {
    const admin = signInAdmin();
    expect((await setRegistration(false, admin.headers)).status).toBe(200);

    for (const body of [
      { enabled: true },
      { registration: { enabled: false }, extra: true, force: true },
    ]) {
      const response = await callAdmin(ADMIN_SETTINGS, {
        method: 'PATCH',
        body,
        headers: admin.headers,
      });
      // The first is a 400 (no `registration` object); the second is a legitimate
      // write of `false` with unknown keys ignored. Both must leave the row at '0'.
      expect([200, 400], JSON.stringify(body)).toContain(response.status);
      expect(readSetting(REGISTRATION_ENABLED_KEY)).toBe('0');
    }
  });
});

describe('guard precision: 401 vs 403 vs 200 follows the live row, not the cookie', () => {
  it('answers 401 for a revoked cookie and for a disabled administrator', async () => {
    const admin = signInAdmin();
    const second = createAdminAccount('precision-second-admin');
    const secondSession = signInAs(second.id, 'precision-second-device');

    // A live second admin: the guard lets it through.
    expect((await callAdmin(ADMIN_USERS, { headers: secondSession.headers })).status).toBe(200);

    const disabled = await callAdmin(`${ADMIN_USERS}/${second.id}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
      headers: admin.headers,
    });
    expect(disabled.status).toBe(200);

    // Disabling revoked the sessions *and* the row says `disabled`: either leg alone
    // must be enough for the guard to answer 401, never 403 and never 200.
    const afterDisable = await callAdmin(ADMIN_USERS, { headers: secondSession.headers });
    expect(afterDisable.status).toBe(401);
    expect(await json<ErrorBody>(afterDisable)).toEqual({ error: { message: 'unauthorized' } });

    // The bootstrap admin still works.
    expect((await callAdmin(ADMIN_USERS, { headers: admin.headers })).status).toBe(200);
  });

  it('reflects a role change on an existing cookie immediately', async () => {
    const admin = signInAdmin();
    const member = createMemberAccount('precision-promote');
    const memberSession = signInAs(member.id, 'precision-promote-device');

    expect((await callAdmin(ADMIN_USERS, { headers: memberSession.headers })).status).toBe(403);

    expect((await callAdmin(`${ADMIN_USERS}/${member.id}`, {
      method: 'PATCH',
      body: { role: 'admin' },
      headers: admin.headers,
    })).status).toBe(200);
    // Same cookie, new authority: no re-login required, no stale privilege.
    expect((await callAdmin(ADMIN_USERS, { headers: memberSession.headers })).status).toBe(200);

    expect((await callAdmin(`${ADMIN_USERS}/${member.id}`, {
      method: 'PATCH',
      body: { role: 'member' },
      headers: admin.headers,
    })).status).toBe(200);
    // And back down again without a re-login.
    expect((await callAdmin(ADMIN_USERS, { headers: memberSession.headers })).status).toBe(403);
  });

  it('accepts the bearer form the PowerShell scripts use on the admin door', async () => {
    const admin = signInAdmin();
    const response = await callAdmin(ADMIN_USERS, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.status).toBe(200);

    const wrongSecret = `${admin.sessionId}.${'c'.repeat(64)}`;
    const refused = await callAdmin(ADMIN_USERS, {
      headers: { authorization: `Bearer ${wrongSecret}` },
    });
    expect(refused.status).toBe(401);
  });

  it('refuses a member on every verb, including the ones it could otherwise reach', async () => {
    const owner = createMemberAccount('precision-member-owner');
    const intruder = createMemberAccount('precision-member-intruder');
    const intruderSession = signInAs(intruder.id, 'precision-intruder-device');
    const victimSession = signInAs(owner.id, 'precision-victim-device');

    const attempts: [string, 'GET' | 'POST' | 'PATCH' | 'DELETE', unknown?][] = [
      [ADMIN_USERS, 'POST', { username: 'member-created', password: TEST_MEMBER_PASSWORD }],
      [`${ADMIN_USERS}/${owner.id}`, 'PATCH', { displayName: 'Hijacked' }],
      [`${ADMIN_USERS}/${owner.id}`, 'DELETE'],
      [`${ADMIN_USERS}/${owner.id}/password`, 'POST', { password: 'Hijack-Pass9' }],
      [`${ADMIN_USERS}/${owner.id}/sessions/${victimSession.sessionId}`, 'DELETE'],
      [ADMIN_SETTINGS, 'PATCH', { registration: { enabled: false } }],
    ];
    for (const [path, method, body] of attempts) {
      const response = await callAdmin(path, {
        method,
        body,
        headers: intruderSession.headers,
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await json<ErrorBody>(response), `${method} ${path}`).toEqual({
        error: { message: 'forbidden' },
      });
    }

    // The member's 403s changed nothing: the victim still holds its session and
    // still has the original password; registration is still open.
    expect(authenticateSessionToken(victimSession.token)).not.toBeNull();
    expect(authenticateUser('precision-member-owner', TEST_MEMBER_PASSWORD)).not.toBeNull();
    expect(isRegistrationEnabled()).toBe(true);
    expect(await usernames(signInAdmin().headers)).toEqual([
      'admin',
      'precision-member-intruder',
      'precision-member-owner',
    ]);
  });
});

describe('rule refusals: 400 with a message an administrator can read', () => {
  const DISPLAYABLE = /[a-z]/i;

  function expectDisplayable(message: string): void {
    expect(message.length).toBeGreaterThanOrEqual(12);
    expect(message.length).toBeLessThan(200);
    expect(message).toMatch(DISPLAYABLE);
    expect(message).not.toMatch(/Error|TypeError|undefined|null\b|\[object/);
    expect(message).not.toMatch(/^\s|\s$|\n/);
  }

  it('refuses a sole administrator demoting or disabling itself, and stays usable', async () => {
    const admin = signInAdmin();
    expect(countActiveAdmins()).toBe(1);

    const demote = await callAdmin(`${ADMIN_USERS}/${admin.userId}`, {
      method: 'PATCH',
      body: { role: 'member' },
      headers: admin.headers,
    });
    expect(demote.status).toBe(400);
    expectDisplayable((await json<ErrorBody>(demote)).error.message);

    const disable = await callAdmin(`${ADMIN_USERS}/${admin.userId}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
      headers: admin.headers,
    });
    expect(disable.status).toBe(400);
    expectDisplayable((await json<ErrorBody>(disable)).error.message);

    const selfDelete = await callAdmin(`${ADMIN_USERS}/${admin.userId}`, {
      method: 'DELETE',
      headers: admin.headers,
    });
    expect(selfDelete.status).toBe(400);
    expectDisplayable((await json<ErrorBody>(selfDelete)).error.message);

    // After all three refusals the instance is still administrable.
    expect(countActiveAdmins()).toBe(1);
    expect(authenticateUser('admin', TEST_ADMIN_PASSWORD)).not.toBeNull();
    expect((await callAdmin(ADMIN_USERS, { headers: admin.headers })).status).toBe(200);
    const detail = await callAdmin(`${ADMIN_USERS}/${admin.userId}`, { headers: admin.headers });
    expect((await json<DataBody<UserDetailPublic>>(detail)).data).toMatchObject({
      role: 'admin',
      status: 'active',
    });
  });

  it('still allows the legitimate leg: deleting a second admin and demoting a second admin', async () => {
    const admin = signInAdmin();
    const doomed = createAdminAccount('rule-doomed-admin');
    expect(countActiveAdmins()).toBe(2);

    // With two admins, demoting one is fine...
    const demoted = await callAdmin(`${ADMIN_USERS}/${doomed.id}`, {
      method: 'PATCH',
      body: { role: 'member' },
      headers: admin.headers,
    });
    expect(demoted.status).toBe(200);
    expect(countActiveAdmins()).toBe(1);

    // ...and the now-member account can be deleted.
    const deleted = await callAdmin(`${ADMIN_USERS}/${doomed.id}`, {
      method: 'DELETE',
      headers: admin.headers,
    });
    expect(deleted.status).toBe(200);
    expect(countActiveAdmins()).toBe(1);

    // And an admin that is *not* the actor can be disabled even while it is the
    // second-to-last admin, because one active admin remains.
    const other = createAdminAccount('rule-other-admin');
    const disabled = await callAdmin(`${ADMIN_USERS}/${other.id}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
      headers: admin.headers,
    });
    expect(disabled.status).toBe(200);
    expect(countActiveAdmins()).toBe(1);
  });

  it('refuses self-disable even when another admin exists (pure self-lockout)', async () => {
    const admin = signInAdmin();
    createAdminAccount('rule-backup-admin');
    const response = await callAdmin(`${ADMIN_USERS}/${admin.userId}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
      headers: admin.headers,
    });
    expect(response.status).toBe(400);
    expectDisplayable((await json<ErrorBody>(response)).error.message);
    expect(authenticateSessionToken(admin.token)).not.toBeNull();
    expect(countActiveAdmins()).toBe(2);
  });
});
