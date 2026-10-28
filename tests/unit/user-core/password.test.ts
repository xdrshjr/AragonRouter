import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  isPasswordHash,
  normalizeUsernameLower,
  parsePasswordHash,
  usernameFragments,
  validatePasswordStrength,
  validateUsername,
  verifyPassword,
} from '@/lib/password';
import { prepareTestEnv } from '../test-helpers';

/**
 * scrypt password hashing and the password/username policy.
 *
 * `npm test` never touches the network, and these cases must stay fast: the
 * default cost is N=16384, r=8, p=1 (~30ms per hash), which is why the suite keeps
 * the number of real hashes modest.
 */

beforeEach(() => {
  prepareTestEnv();
});

describe('password: scrypt hashing', () => {
  it('stores a self-describing scrypt$N,r,p$salt$hash string', () => {
    const stored = hashPassword('correct-horse-1');
    const [algorithm, params, salt, digest, ...rest] = stored.split('$');
    expect(rest).toHaveLength(0);
    expect(algorithm).toBe('scrypt');
    expect(params).toBe('16384,8,1');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).toMatch(/^[0-9a-f]{128}$/);
    // The plaintext must never survive in the stored value.
    expect(stored).not.toContain('correct-horse-1');
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 16_384, r: 8, p: 1 });
  });

  it('uses a fresh salt per hash, so equal passwords produce different digests', () => {
    const first = hashPassword('same-password-1');
    const second = hashPassword('same-password-1');
    expect(first).not.toBe(second);
    expect(verifyPassword('same-password-1', first)).toBe(true);
    expect(verifyPassword('same-password-1', second)).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', () => {
    const stored = hashPassword('unit-Passw0rd');
    expect(verifyPassword('unit-Passw0rd', stored)).toBe(true);
    expect(verifyPassword('unit-Passw0rd ', stored)).toBe(false);
    expect(verifyPassword('Unit-Passw0rd', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('returns false - never throws - for corrupted or foreign hashes', () => {
    const corrupted = [
      '',
      '   ',
      'garbage',
      'scrypt$',
      'scrypt$16384,8,1$',
      'scrypt$16384,8,1$deadbeef$',
      'scrypt$16384,8,1$deadbeef$deadbeef',
      'scrypt$notanumber,8,1$aa$bb',
      'scrypt$99999999,8,1$aabb$aabb',
      'scrypt$3,8,1$aabbccddeeff00112233445566778899$aabb',
      'bcrypt$16384,8,1$aa$bb',
      'sha256$aa$bb',
      null,
      undefined,
      42,
      {},
    ];
    for (const value of corrupted) {
      expect(() => verifyPassword('unit-Passw0rd', value)).not.toThrow();
      expect(verifyPassword('unit-Passw0rd', value), String(value)).toBe(false);
    }
  });

  it('parses a stored hash and reports malformed ones as null', () => {
    const parsed = parsePasswordHash(hashPassword('parse-me-1'));
    expect(parsed?.params).toEqual({ N: 16384, r: 8, p: 1 });
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.hash).toHaveLength(64);
    expect(parsePasswordHash('nope')).toBeNull();
    expect(parsePasswordHash(undefined)).toBeNull();
    // Non-power-of-two N would make the KDF reject the value at verify time.
    expect(parsePasswordHash('scrypt$1000,8,1$aabb$aabb')).toBeNull();
  });

  it('reports whether a value is already a hash', () => {
    expect(isPasswordHash(hashPassword('hash-me-1'))).toBe(true);
    expect(isPasswordHash('hash-me-1')).toBe(false);
  });

  it('refuses a stored row whose cost parameters would exhaust memory', () => {
    // This profile needs ~4 GiB: a writable database file must not be able to turn
    // one login attempt into a multi-gigabyte allocation.
    const hostile = `scrypt$1048576,32,16$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
    expect(parsePasswordHash(hostile)).toBeNull();
    expect(verifyPassword('unit-Passw0rd', hostile)).toBe(false);
    expect(parsePasswordHash(hashPassword('bounds-1'))?.params).toEqual({ N: 16384, r: 8, p: 1 });
  });

  it('refuses to hash a non-string or empty password', () => {
    expect(() => hashPassword('')).toThrow(/non-empty string/);
    expect(() => hashPassword(undefined)).toThrow(/non-empty string/);
  });
});

describe('password: strength policy', () => {
  const accept = (password: string, username?: string) => {
    const verdict = validatePasswordStrength(password, username);
    expect(verdict.ok, `${password} -> ${verdict.message}`).toBe(true);
    expect(verdict.problem).toBeNull();
  };
  const reject = (password: unknown, username?: string, problem?: string) => {
    const verdict = validatePasswordStrength(password, username);
    expect(verdict.ok, `${String(password)} should have been rejected`).toBe(false);
    expect(verdict.message).toBeTruthy();
    if (problem) expect(verdict.problem).toBe(problem);
  };

  it('accepts a password with letters and digits of at least 8 characters', () => {
    accept('Passw0rd');
    accept('a1b2c3d4');
    accept('A-much-longer-passphrase-9');
  });

  it('rejects passwords shorter than 8 characters', () => {
    reject('Pass0rd', undefined, 'too_short');
    reject('a1', undefined, 'too_short');
    reject('', undefined, 'required');
    reject(undefined, undefined, 'required');
    reject(12345678, undefined, 'required');
  });

  it('rejects letters-only and digits-only passwords', () => {
    reject('passwordonly', undefined, 'missing_digit');
    reject('1234567890', undefined, 'missing_letter');
  });

  it('rejects a password that contains the username', () => {
    reject('alice-is-here-1', 'alice', 'contains_username');
    reject('ALICE-is-here-1', 'alice', 'contains_username');
    reject('bob.smith2024', 'bob.smith', 'contains_username');
    // Fragments split on the separators are checked too ("smith" alone).
    reject('smith2024x', 'bob.smith', 'contains_username');
    // Trailing digits are stripped, so the bare name is caught as well.
    reject('carol99-here1', 'carol99', 'contains_username');
  });

  it('does not reject a password that merely shares a short prefix with the username', () => {
    // "bo" is too short to be a meaningful fragment; blocking it would rule out
    // most passwords without catching anything.
    accept('boardwalk-1', 'bob');
  });

  it('rejects absurdly long passwords', () => {
    reject('a1'.repeat(200), undefined, 'too_long');
  });

  it('splits a username into the fragments that must not appear in a password', () => {
    expect(usernameFragments('Alice')).toEqual(['alice']);
    expect(usernameFragments('bob.smith')).toEqual(['bob.smith', 'bob', 'smith']);
    expect(usernameFragments('carol2024')).toEqual(['carol2024', 'carol']);
    expect(usernameFragments(undefined)).toEqual([]);
    expect(usernameFragments('ab')).toEqual([]);
  });

  it('normalizes usernames case-insensitively', () => {
    expect(normalizeUsernameLower('  Alice ')).toBe('alice');
    expect(normalizeUsernameLower('BOB')).toBe('bob');
  });
});

describe('password: username rules', () => {
  it('accepts usernames of 3-32 allowed characters', () => {
    for (const username of ['abc', 'Alice', 'user.name', 'user-name', 'user_name', 'u12345']) {
      expect(validateUsername(username), username).toBeNull();
    }
  });

  it('rejects empty, too short, too long and illegal usernames', () => {
    expect(validateUsername('')).toMatch(/required/);
    expect(validateUsername('   ')).toMatch(/required/);
    expect(validateUsername(undefined)).toMatch(/required/);
    expect(validateUsername(42)).toMatch(/required/);
    expect(validateUsername('ab')).toMatch(/at least 3/);
    expect(validateUsername('a'.repeat(33))).toMatch(/at most 32/);
    expect(validateUsername('-abc')).toMatch(/must start/);
    expect(validateUsername('.abc')).toMatch(/must start/);
    expect(validateUsername('a/b')).toMatch(/may only contain/);
    expect(validateUsername('a b')).toMatch(/may only contain/);
    expect(validateUsername('ad min')).toMatch(/may only contain/);
    expect(validateUsername('😀user')).toMatch(/may only contain/);
    expect(validateUsername('<script>')).toMatch(/may only contain/);
  });
});
