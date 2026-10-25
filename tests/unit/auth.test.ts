import { beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
  isAdminRequest,
  parseCookies,
  requireAdmin,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  verifyAdminPassword,
  verifySessionToken,
} from '@/lib/auth';
import { hmacSha256Hex } from '@/lib/crypto';
import { TEST_ADMIN_PASSWORD, TEST_SESSION_SECRET, prepareTestEnv } from './test-helpers';

beforeEach(() => {
  prepareTestEnv();
});

describe('auth: admin password', () => {
  it('accepts the configured password', () => {
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);
  });

  it('rejects wrong, empty and non-string candidates', () => {
    expect(verifyAdminPassword('nope')).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
    expect(verifyAdminPassword(undefined)).toBe(false);
    expect(verifyAdminPassword(123)).toBe(false);
    expect(verifyAdminPassword(null)).toBe(false);
  });

  it('fails closed when ADMIN_PASSWORD is not configured', () => {
    delete process.env.ADMIN_PASSWORD;
    try {
      expect(verifyAdminPassword('anything')).toBe(false);
    } finally {
      process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    }
  });
});

describe('auth: session tokens', () => {
  it('creates <exp>.<hmacHex> tokens valid for seven days', () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(now);
    const [exp, signature, ...rest] = token.split('.');
    expect(rest).toHaveLength(0);
    expect(Number(exp)).toBe(now + SESSION_TTL_MS);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toBe(hmacSha256Hex(TEST_SESSION_SECRET, String(now + SESSION_TTL_MS)));
    expect(verifySessionToken(token, now)).toBe(true);
    expect(verifySessionToken(token, now + SESSION_TTL_MS - 1000)).toBe(true);
  });

  it('expires after seven days', () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(now);
    expect(verifySessionToken(token, now + SESSION_TTL_MS + 1)).toBe(false);
  });

  it('rejects a tampered expiry or signature', () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(now);
    const [, signature] = token.split('.');
    const forgedExpiry = String(now + SESSION_TTL_MS * 10);
    expect(verifySessionToken(`${forgedExpiry}.${signature}`, now)).toBe(false);
    expect(verifySessionToken(`${now + SESSION_TTL_MS}.${'0'.repeat(64)}`, now)).toBe(false);
    expect(verifySessionToken(`${now + SESSION_TTL_MS}`, now)).toBe(false);
    expect(verifySessionToken('', now)).toBe(false);
    expect(verifySessionToken(undefined, now)).toBe(false);
  });

  it('rejects tokens signed with a different secret', () => {
    const token = createSessionToken(Date.now(), 'a-completely-different-secret-value-000');
    expect(verifySessionToken(token)).toBe(false);
  });

  it('fails closed when SESSION_SECRET is missing', () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      expect(() => createSessionToken()).toThrow(/SESSION_SECRET/);
      expect(verifySessionToken('123.sig')).toBe(false);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});

describe('auth: cookies and request guards', () => {
  it('parses a Cookie header including quoted and encoded values', () => {
    expect(parseCookies('a=1; b=two; aragon_session=x.y')).toEqual({
      a: '1',
      b: 'two',
      aragon_session: 'x.y',
    });
    expect(parseCookies('q="quoted"; enc=a%20b')).toEqual({ q: 'quoted', enc: 'a b' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('broken')).toEqual({});
  });

  it('serializes a HttpOnly SameSite=Lax session cookie', () => {
    const cookie = serializeSessionCookie('123.sig');
    expect(cookie).toContain(`${SESSION_COOKIE}=123.sig`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toContain('Secure');
  });

  it('serializes a cleared cookie', () => {
    const cookie = serializeClearedSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
  });

  it('requireAdmin accepts a valid cookie and a valid bearer token', () => {
    const token = createSessionToken();
    const withCookie = new Request('http://localhost/api/admin/keys', {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${token}` },
    });
    expect(requireAdmin(withCookie)).toBe(true);
    expect(isAdminRequest(withCookie)).toBe(true);

    const withBearer = new Request('http://localhost/api/admin/keys', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(requireAdmin(withBearer)).toBe(true);
  });

  it('requireAdmin rejects missing, malformed and foreign cookies', () => {
    expect(requireAdmin(new Request('http://localhost/api/admin/keys'))).toBe(false);
    expect(
      requireAdmin(
        new Request('http://localhost/api/admin/keys', { headers: { cookie: `${SESSION_COOKIE}=garbage` } }),
      ),
    ).toBe(false);
    const foreign = createSessionToken(Date.now(), 'other-secret-other-secret-other-secret');
    expect(
      requireAdmin(
        new Request('http://localhost/api/admin/keys', {
          headers: { cookie: `${SESSION_COOKIE}=${foreign}` },
        }),
      ),
    ).toBe(false);
  });
});
