import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@/lib/crypto';
import { execute, queryAll, queryOne } from '@/lib/db';
import {
  SESSION_COOKIE,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  authenticateRequest,
  authenticateSessionToken,
  createSession,
  describeSessionClient,
  getSessionById,
  getSessionTokenFromRequest,
  hashSessionSecret,
  hasSessionCookieShape,
  listUserSessions,
  parseSessionToken,
  revokeAllSessions,
  revokeSession,
} from '@/lib/sessions';
import { UserNotFoundError, createUser, ensureBootstrapAdmin } from '@/lib/users';
import { TEST_MEMBER_PASSWORD, prepareTestEnv } from '../test-helpers';

/**
 * C-SESSION-STORE: create, authenticate, revoke, list.
 *
 * The security-critical cases are the ones where a stale credential must stop
 * working: expiry, revocation, a disabled owner, and "log out everywhere".
 */

const NOW = 1_700_000_000_000;

beforeEach(() => {
  prepareTestEnv();
});

function member(username = 'session-user') {
  return createUser({ username, password: TEST_MEMBER_PASSWORD, role: 'member' });
}

function requestWith(token: string, scheme: 'cookie' | 'bearer' = 'cookie'): Request {
  const headers: Record<string, string> =
    scheme === 'cookie'
      ? { cookie: `other=1; ${SESSION_COOKIE}=${token}` }
      : { authorization: `Bearer ${token}` };
  return new Request('http://localhost/api/admin/session', { headers });
}

describe('sessions: creation (C-TOKEN)', () => {
  it('mints `<32 hex sessionId>.<64 hex secret>` and a seven day expiry', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW, userAgent: 'vitest/1.0', ip: '127.0.0.1' });
    expect(session.token).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(session.sessionId).toBe(session.token.split('.')[0]);
    expect(session.expiresAt).toBe(NOW + SESSION_TTL_MS);

    const row = getSessionById(session.sessionId);
    expect(row?.user_id).toBe(user.id);
    expect(row?.user_agent).toBe('vitest/1.0');
    expect(row?.ip).toBe('127.0.0.1');
    expect(Number(row?.expires_at)).toBe(NOW + SESSION_TTL_MS);
    expect(row?.revoked_at).toBeNull();
  });

  it('stores only sha256(secret) in token_hash', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    const secret = session.token.split('.')[1] ?? '';
    const row = getSessionById(session.sessionId);
    expect(row?.token_hash).toBe(sha256Hex(secret));
    expect(row?.token_hash).toBe(hashSessionSecret(secret));
    expect(String(row?.token_hash)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('honours a custom TTL and clips a hostile user agent', () => {
    const user = member();
    const session = createSession(user.id, {
      now: NOW,
      ttlMs: 60_000,
      userAgent: 'a'.repeat(1000),
    });
    expect(session.expiresAt).toBe(NOW + 60_000);
    expect(String(getSessionById(session.sessionId)?.user_agent)).toHaveLength(300);
  });

  it('refuses to create a session for an unknown user', () => {
    expect(() => createSession('missing-user')).toThrow(UserNotFoundError);
    expect(() => createSession('')).toThrow(UserNotFoundError);
    expect(() => createSession(undefined)).toThrow(UserNotFoundError);
    expect(queryAll('SELECT id FROM user_sessions')).toHaveLength(0);
  });

  it('parses and shapes tokens without ever accepting a bare id or secret', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    const [sessionId, secret] = session.token.split('.');
    expect(parseSessionToken(session.token)).toEqual({ sessionId, secret });
    expect(hasSessionCookieShape(session.token)).toBe(true);
    expect(hasSessionCookieShape(sessionId)).toBe(false);
    expect(hasSessionCookieShape(secret)).toBe(false);
    expect(hasSessionCookieShape(undefined)).toBe(false);
  });

  /**
   * Regression (C-TOKEN consumer drift): the module used to export a second,
   * identical guard (`isValidSessionTokenShape`). Two names for one rule let the
   * console gate and the API drift onto different helpers, so only one may exist -
   * and it must be the one the contract names.
   */
  it('exposes exactly one shape guard, the one the contract names', async () => {
    const shapeGuards = Object.entries(await import('@/lib/sessions')).filter(
      ([name, value]) => typeof value === 'function' && /Shape$/.test(name),
    );
    expect(shapeGuards.map(([name]) => name)).toEqual(['hasSessionCookieShape']);
  });

  it('describes the caller from proxy headers, and stays null when they are absent', () => {
    const withProxy = new Request('http://localhost/api/admin/session', {
      headers: {
        'user-agent': 'Mozilla/5.0 (device)',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-real-ip': '10.0.0.9',
      },
    });
    expect(describeSessionClient(withProxy)).toEqual({
      userAgent: 'Mozilla/5.0 (device)',
      ip: '203.0.113.7',
    });

    const withRealIp = new Request('http://localhost/api/admin/session', {
      headers: { 'x-real-ip': '198.51.100.4' },
    });
    expect(describeSessionClient(withRealIp)).toEqual({ userAgent: null, ip: '198.51.100.4' });

    // Nothing is invented for a request that carries no headers at all.
    expect(describeSessionClient(new Request('http://localhost/api/admin/session'))).toEqual({
      userAgent: null,
      ip: null,
    });
  });
});

describe('sessions: authentication', () => {
  it('resolves a live cookie session to its actor', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW, userAgent: 'device-a', ip: '10.0.0.1' });
    const context = authenticateRequest(requestWith(session.token), NOW);
    expect(context?.user).toEqual({
      id: user.id,
      username: user.username,
      role: 'member',
      status: 'active',
    });
    expect(context?.session.id).toBe(session.sessionId);
    expect(context?.session.userId).toBe(user.id);
    expect(context?.session.userAgent).toBe('device-a');
    expect(context?.session.ip).toBe('10.0.0.1');
    expect(context?.session.createdAt).toBe(new Date(NOW).toISOString());
    expect(context?.session.expiresAt).toBe(new Date(NOW + SESSION_TTL_MS).toISOString());
  });

  it('accepts a bearer token for the scripts', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    expect(authenticateRequest(requestWith(session.token, 'bearer'), NOW)?.user.id).toBe(user.id);
  });

  it('returns null for an expired session', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW, ttlMs: 1000 });
    expect(authenticateRequest(requestWith(session.token), NOW + 999)).not.toBeNull();
    expect(authenticateRequest(requestWith(session.token), NOW + 1000)).toBeNull();
  });

  it('returns null for a revoked session', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    expect(revokeSession(session.sessionId, NOW + 10)).toBe(true);
    expect(authenticateRequest(requestWith(session.token), NOW + 11)).toBeNull();
  });

  it('returns null as soon as the owner is disabled', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    expect(authenticateRequest(requestWith(session.token), NOW)).not.toBeNull();
    execute("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(authenticateRequest(requestWith(session.token), NOW)).toBeNull();
  });

  it('returns null for a wrong secret, an unknown session or a missing cookie', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    const [sessionId] = session.token.split('.');
    expect(authenticateRequest(requestWith(`${sessionId}.${'0'.repeat(64)}`), NOW)).toBeNull();
    expect(authenticateRequest(requestWith(`${'f'.repeat(32)}.${'0'.repeat(64)}`), NOW)).toBeNull();
    expect(authenticateRequest(new Request('http://localhost/'), NOW)).toBeNull();
    expect(authenticateRequest(requestWith('garbage'), NOW)).toBeNull();
    expect(authenticateSessionToken(undefined, NOW)).toBeNull();
  });

  it('throttles the last_seen_at write to once a minute', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    const first = authenticateRequest(requestWith(session.token), NOW + 5000);
    expect(first).not.toBeNull();
    // Within the interval nothing is written: the reported value is the stored one.
    expect(Number(getSessionById(session.sessionId)?.last_seen_at)).toBe(NOW);
    expect(first?.session.lastSeenAt).toBe(new Date(NOW).toISOString());

    const later = authenticateRequest(
      requestWith(session.token),
      NOW + SESSION_TOUCH_INTERVAL_MS + 1,
    );
    expect(Number(getSessionById(session.sessionId)?.last_seen_at)).toBe(
      NOW + SESSION_TOUCH_INTERVAL_MS + 1,
    );
    expect(later?.session.lastSeenAt).toBe(
      new Date(NOW + SESSION_TOUCH_INTERVAL_MS + 1).toISOString(),
    );
  });

  it('reads the token from the cookie before the Authorization header', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    const request = new Request('http://localhost/', {
      headers: {
        cookie: `${SESSION_COOKIE}=${session.token}`,
        authorization: 'Bearer garbage',
      },
    });
    expect(getSessionTokenFromRequest(request)).toBe(session.token);
    expect(authenticateRequest(request, NOW)).not.toBeNull();
  });
});

describe('sessions: revocation', () => {
  it('revokes one session and keeps the rest', () => {
    const user = member();
    const first = createSession(user.id, { now: NOW });
    const second = createSession(user.id, { now: NOW });
    expect(revokeSession(first.sessionId, NOW + 1)).toBe(true);
    expect(authenticateRequest(requestWith(first.token), NOW + 2)).toBeNull();
    expect(authenticateRequest(requestWith(second.token), NOW + 2)).not.toBeNull();
  });

  it('is idempotent and keeps the original revoked_at', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    revokeSession(session.sessionId, NOW + 1);
    expect(revokeSession(session.sessionId, NOW + 500)).toBe(true);
    expect(Number(getSessionById(session.sessionId)?.revoked_at)).toBe(NOW + 1);
    expect(revokeSession('missing')).toBe(false);
    expect(revokeSession('')).toBe(false);
    expect(revokeSession(undefined)).toBe(false);
  });

  it('revokeAllSessions drops every device and reports how many', () => {
    const user = member();
    createSession(user.id, { now: NOW });
    createSession(user.id, { now: NOW });
    createSession(user.id, { now: NOW });
    expect(revokeAllSessions(user.id, { now: NOW + 10 })).toBe(3);
    expect(revokeAllSessions(user.id, { now: NOW + 20 })).toBe(0);
    expect(listUserSessions(user.id, { now: NOW + 20 })).toHaveLength(0);
  });

  it('revokeAllSessions({ exceptSessionId }) keeps the current session', () => {
    const user = member();
    const current = createSession(user.id, { now: NOW });
    const other = createSession(user.id, { now: NOW });
    expect(revokeAllSessions(user.id, { exceptSessionId: current.sessionId, now: NOW + 10 })).toBe(1);

    expect(authenticateRequest(requestWith(current.token), NOW + 11)).not.toBeNull();
    expect(authenticateRequest(requestWith(other.token), NOW + 11)).toBeNull();
  });

  it('treats an unknown user id as nothing to revoke', () => {
    expect(revokeAllSessions('missing')).toBe(0);
    expect(revokeAllSessions(undefined)).toBe(0);
  });
});

describe('sessions: device listing', () => {
  it('lists live sessions newest first with the current one flagged', () => {
    const user = member();
    const older = createSession(user.id, { now: NOW, userAgent: 'old-device' });
    const newer = createSession(user.id, { now: NOW + 1000, userAgent: 'new-device' });

    const sessions = listUserSessions(user.id, {
      currentSessionId: older.sessionId,
      now: NOW + 2000,
    });
    expect(sessions.map((entry) => entry.id)).toEqual([newer.sessionId, older.sessionId]);
    expect(sessions[0]?.current).toBe(false);
    expect(sessions[1]?.current).toBe(true);
    expect(sessions[0]?.userAgent).toBe('new-device');
    expect(sessions[0]?.createdAt).toBe(new Date(NOW + 1000).toISOString());
    expect(sessions[0]?.expiresAt).toBe(new Date(NOW + 1000 + SESSION_TTL_MS).toISOString());
  });

  it('hides revoked and expired sessions', () => {
    const user = member();
    const live = createSession(user.id, { now: NOW });
    const revoked = createSession(user.id, { now: NOW });
    const expired = createSession(user.id, { now: NOW, ttlMs: 10 });
    revokeSession(revoked.sessionId, NOW + 1);

    const sessions = listUserSessions(user.id, { now: NOW + 100 });
    expect(sessions.map((entry) => entry.id)).toEqual([live.sessionId]);
    expect(sessions[0]?.expiresAt).toBe(new Date(NOW + SESSION_TTL_MS).toISOString());
    expect(expired.sessionId).not.toBe(live.sessionId);
  });

  it('never leaks the token hash through the device list', () => {
    const user = member();
    const session = createSession(user.id, { now: NOW });
    const serialized = JSON.stringify(listUserSessions(user.id, { now: NOW }));
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain(session.token);
    expect(serialized).not.toContain(session.token.split('.')[1] ?? '#');
  });

  it('returns an empty list for an unknown or missing user', () => {
    expect(listUserSessions('missing')).toEqual([]);
    expect(listUserSessions(undefined)).toEqual([]);
  });
});

describe('sessions: lifecycle against the bootstrap admin', () => {
  it('keeps the admin signed in on one device while logging out the other', () => {
    const admin = ensureBootstrapAdmin(NOW);
    const laptop = createSession(admin.id, { now: NOW, userAgent: 'laptop' });
    const phone = createSession(admin.id, { now: NOW, userAgent: 'phone' });

    revokeAllSessions(admin.id, { exceptSessionId: laptop.sessionId, now: NOW + 1 });
    const remaining = listUserSessions(admin.id, {
      currentSessionId: laptop.sessionId,
      now: NOW + 2,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.userAgent).toBe('laptop');
    expect(remaining[0]?.current).toBe(true);

    const context = authenticateRequest(requestWith(phone.token), NOW + 2);
    expect(context).toBeNull();
  });

  it('purges sessions that expired more than one TTL ago', () => {
    const user = member();
    const stale = createSession(user.id, { now: NOW - 3 * SESSION_TTL_MS });
    createSession(user.id, { now: NOW });
    expect(queryOne('SELECT id FROM user_sessions WHERE id = ?', [stale.sessionId])).toBeUndefined();
  });
});
