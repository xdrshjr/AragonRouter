import { beforeEach, describe, expect, it } from 'vitest';
import * as keysRoute from '@/app/api/admin/keys/route';
import {
  forbidden,
  mapDomainError,
  unauthorized,
  withAdmin,
  withAuth,
} from '@/lib/api-helpers';
import { SESSION_COOKIE, createSession, revokeSession } from '@/lib/sessions';
import {
  RegistrationClosedError,
  deleteSetting,
  getRegistrationSetting,
  isRegistrationEnabled,
  readSetting,
  setRegistrationEnabled,
  assertRegistrationOpen,
  writeSetting,
} from '@/lib/settings';
import type { AuthContext } from '@/lib/types';
import {
  UserNotFoundError,
  UserRuleError,
  UserValidationError,
  createUser,
  ensureBootstrapAdmin,
} from '@/lib/users';
import { TEST_MEMBER_PASSWORD, jsonRequest, readJson, prepareTestEnv } from '../test-helpers';

/**
 * C-GUARD: `withAuth` / `withAdmin` semantics, plus the registration switch and
 * the 400/403/404 mapping the account routes rely on.
 *
 * The important distinction for the UI: **401** means "your session is gone"
 * (the console redirects to the login page), **403** means "you are signed in but
 * this is not yours to do" (the console must not navigate away).
 */

const BASE = 'http://localhost';

beforeEach(() => {
  prepareTestEnv();
});

function cookieFor(userId: string): Record<string, string> {
  const session = createSession(userId, { userAgent: 'vitest-guard' });
  return { cookie: `${SESSION_COOKIE}=${session.token}` };
}

function adminCookie(): Record<string, string> {
  return cookieFor(ensureBootstrapAdmin().id);
}

function memberCookie(username = 'guard-member'): Record<string, string> {
  const user = createUser({ username, password: TEST_MEMBER_PASSWORD, role: 'member' });
  return cookieFor(user.id);
}

describe('guards: withAuth (C-GUARD)', () => {
  it('answers 401 {error:{message:"unauthorized"}} without a cookie', async () => {
    let called = false;
    const response = await withAuth(new Request(`${BASE}/api/admin/session`), () => {
      called = true;
      return new Response('should not run', { status: 200 });
    });
    expect(called).toBe(false);
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ error: { message: 'unauthorized' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('hands the actor to the handler for a member and for an admin', async () => {
    const seen: AuthContext[] = [];
    const memberResponse = await withAuth(
      new Request(`${BASE}/api/account`, { headers: memberCookie() }),
      (_request, context) => {
        seen.push(context);
        return new Response(JSON.stringify({ data: { role: context.user.role } }), { status: 200 });
      },
    );
    expect(memberResponse.status).toBe(200);
    expect(await readJson(memberResponse)).toEqual({ data: { role: 'member' } });

    const adminResponse = await withAuth(
      new Request(`${BASE}/api/account`, { headers: adminCookie() }),
      (_request, context) => {
        seen.push(context);
        return new Response(JSON.stringify({ data: { role: context.user.role } }), { status: 200 });
      },
    );
    expect(await readJson(adminResponse)).toEqual({ data: { role: 'admin' } });
    expect(seen.map((context) => context.user.role)).toEqual(['member', 'admin']);
    expect(seen[0]?.session.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('answers 401 for an expired, revoked or malformed session', async () => {
    const user = createUser({ username: 'expiring', password: TEST_MEMBER_PASSWORD, role: 'member' });
    const expired = createSession(user.id, { now: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    const revoked = createSession(user.id);
    revokeSession(revoked.sessionId);

    for (const token of [expired.token, revoked.token, 'garbage', `${'a'.repeat(32)}.${'b'.repeat(64)}`]) {
      const response = await withAuth(
        new Request(`${BASE}/api/account`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
        () => new Response('should not run'),
      );
      expect(response.status, token).toBe(401);
      expect(await readJson(response)).toEqual({ error: { message: 'unauthorized' } });
    }
  });

  it('answers 500 - not 401 - when the handler throws, and never echoes the token', async () => {
    const headers = adminCookie();
    const token = (headers.cookie ?? '').split('=')[1] ?? '';
    const response = await withAuth(new Request(`${BASE}/api/account`, { headers }), () => {
      throw new Error('boom');
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(token);
  });
});

describe('guards: withAdmin (C-GUARD)', () => {
  it('answers 401 without a session', async () => {
    const response = await withAdmin(jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET' }), () =>
      new Response('should not run'),
    );
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ error: { message: 'unauthorized' } });
  });

  it('answers 403 {error:{message:"forbidden"}} for a member', async () => {
    const response = await withAdmin(
      jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: memberCookie() }),
      () => new Response('should not run'),
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ error: { message: 'forbidden' } });
    // 403 must not look like an expired session: the UI keys its redirect on 401.
    expect(response.status).not.toBe(401);
  });

  it('lets an admin through and passes the actor as the second argument', async () => {
    let role: string | undefined;
    const response = await withAdmin(
      jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: adminCookie() }),
      (_request, context) => {
        role = context?.user.role;
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      },
    );
    expect(response.status).toBe(200);
    expect(role).toBe('admin');
    expect(await readJson(response)).toEqual({ data: { ok: true } });
  });

  it('keeps the existing one-argument handlers working (backwards compatible arity)', async () => {
    const response = await withAdmin(
      jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: adminCookie() }),
      () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    expect(response.status).toBe(200);
  });

  it('answers 403, not 401, for a member session on the real admin route', async () => {
    const response = await keysRoute.GET(
      jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: memberCookie('route-member') }),
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ error: { message: 'forbidden' } });
  });

  it('answers 401 on the real admin route without a session and 200 with an admin one', async () => {
    const anonymous = await keysRoute.GET(jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET' }));
    expect(anonymous.status).toBe(401);
    const authorized = await keysRoute.GET(
      jsonRequest(`${BASE}/api/admin/keys`, { method: 'GET', headers: adminCookie() }),
    );
    expect(authorized.status).toBe(200);
  });

  it('exposes the raw envelope helpers', () => {
    const unauthorizedResponse = unauthorized();
    expect(unauthorizedResponse.status).toBe(401);
    const forbiddenResponse = forbidden();
    expect(forbiddenResponse.status).toBe(403);
  });
});

describe('errors: domain mapping for the account routes', () => {
  it('maps user validation and rule errors to 400', async () => {
    const validation = mapDomainError(new UserValidationError('username is already taken'));
    expect(validation?.status).toBe(400);
    expect(await readJson(validation as Response)).toEqual({
      error: { message: 'username is already taken' },
    });
    const rule = mapDomainError(new UserRuleError('at least one active admin must remain'));
    expect(rule?.status).toBe(400);
  });

  it('maps a missing user to 404 and closed registration to 403', () => {
    expect(mapDomainError(new UserNotFoundError())?.status).toBe(404);
    expect(mapDomainError(new RegistrationClosedError())?.status).toBe(403);
    expect(mapDomainError(new Error('unexpected'))).toBeNull();
  });
});

describe('settings: registration switch (C-SCHEMA)', () => {
  it('is open by default and when the row is missing', () => {
    expect(readSetting('registration_enabled')).toBeNull();
    expect(isRegistrationEnabled()).toBe(true);
    expect(getRegistrationSetting()).toEqual({ enabled: true });
  });

  it('persists the documented 1/0 values', () => {
    expect(setRegistrationEnabled(false)).toBe(false);
    expect(readSetting('registration_enabled')).toBe('0');
    expect(isRegistrationEnabled()).toBe(false);
    expect(getRegistrationSetting()).toEqual({ enabled: false });

    expect(setRegistrationEnabled(true)).toBe(true);
    expect(readSetting('registration_enabled')).toBe('1');
    expect(isRegistrationEnabled()).toBe(true);
  });

  it('re-opens registration when the row is deleted', () => {
    setRegistrationEnabled(false);
    expect(deleteSetting('registration_enabled')).toBe(true);
    expect(isRegistrationEnabled()).toBe(true);
    expect(deleteSetting('registration_enabled')).toBe(false);
  });

  it('treats an unreadable value as open rather than locking everyone out', () => {
    writeSetting('registration_enabled', 'maybe');
    expect(isRegistrationEnabled()).toBe(true);
  });

  it('throws RegistrationClosedError when registration is closed', () => {
    expect(() => assertRegistrationOpen()).not.toThrow();
    setRegistrationEnabled(false);
    expect(() => assertRegistrationOpen()).toThrow(RegistrationClosedError);
  });

  it('does not disturb unrelated settings', () => {
    writeSetting('some_other_flag', 'keep-me');
    setRegistrationEnabled(false);
    expect(readSetting('some_other_flag')).toBe('keep-me');
  });
});
