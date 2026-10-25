import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  DEFAULT_DATABASE_PATH,
  getAdminPassword,
  getAnthropicDefaultVersion,
  getDatabasePath,
  getEncryptionKeyHex,
  getProviderTestTimeoutMs,
  getRelayTimeoutMs,
  getSessionSecret,
  isCookieSecureEnabled,
} from '@/lib/env';
import { TEST_ADMIN_PASSWORD, TEST_ENCRYPTION_KEY, TEST_SESSION_SECRET, prepareTestEnv } from './test-helpers';

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  prepareTestEnv();
});

describe('env: SESSION_SECRET', () => {
  it('returns the configured secret', () => {
    expect(getSessionSecret()).toBe(TEST_SESSION_SECRET);
  });

  it('rejects a missing, empty or whitespace-only secret', () => {
    delete process.env.SESSION_SECRET;
    expect(() => getSessionSecret()).toThrow(ConfigurationError);
    expect(() => getSessionSecret()).toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = '   ';
    expect(() => getSessionSecret()).toThrow(ConfigurationError);
  });

  it('requires at least 32 characters', () => {
    process.env.SESSION_SECRET = 'a'.repeat(31);
    expect(() => getSessionSecret()).toThrow(/at least 32/);
    process.env.SESSION_SECRET = 'a'.repeat(32);
    expect(getSessionSecret()).toBe('a'.repeat(32));
  });

  it('never echoes the secret value in the error message', () => {
    process.env.SESSION_SECRET = 'short-secret-value';
    let message = '';
    try {
      getSessionSecret();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('short-secret-value');
  });
});

describe('env: ENCRYPTION_KEY', () => {
  it('accepts exactly 64 hex characters and lowercases them', () => {
    expect(getEncryptionKeyHex()).toBe(TEST_ENCRYPTION_KEY);
    process.env.ENCRYPTION_KEY = 'A'.repeat(64);
    expect(getEncryptionKeyHex()).toBe('a'.repeat(64));
  });

  it('rejects a missing, short, long or non-hex key', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => getEncryptionKeyHex()).toThrow(ConfigurationError);
    process.env.ENCRYPTION_KEY = 'a'.repeat(63);
    expect(() => getEncryptionKeyHex()).toThrow(/64 hex/);
    process.env.ENCRYPTION_KEY = 'a'.repeat(65);
    expect(() => getEncryptionKeyHex()).toThrow(/64 hex/);
    process.env.ENCRYPTION_KEY = 'z'.repeat(64);
    expect(() => getEncryptionKeyHex()).toThrow(/64 hex/);
  });
});

describe('env: ADMIN_PASSWORD', () => {
  it('returns the configured password', () => {
    expect(getAdminPassword()).toBe(TEST_ADMIN_PASSWORD);
  });

  it('throws a configuration error when unset so logins fail closed', () => {
    delete process.env.ADMIN_PASSWORD;
    expect(() => getAdminPassword()).toThrow(ConfigurationError);
  });
});

describe('env: DATABASE_PATH', () => {
  it('defaults to ./data/aragon.db', () => {
    delete process.env.DATABASE_PATH;
    expect(getDatabasePath()).toBe(DEFAULT_DATABASE_PATH);
    expect(DEFAULT_DATABASE_PATH).toBe('./data/aragon.db');
  });

  it('uses an explicit override and treats a blank value as unset', () => {
    process.env.DATABASE_PATH = '/tmp/custom.db';
    expect(getDatabasePath()).toBe('/tmp/custom.db');
    process.env.DATABASE_PATH = '   ';
    expect(getDatabasePath()).toBe(DEFAULT_DATABASE_PATH);
  });
});

describe('env: runtime flags', () => {
  it('keeps the cookie insecure by default and opts in via COOKIE_SECURE', () => {
    expect(isCookieSecureEnabled()).toBe(false);
    process.env.COOKIE_SECURE = '1';
    expect(isCookieSecureEnabled()).toBe(true);
    process.env.COOKIE_SECURE = 'true';
    expect(isCookieSecureEnabled()).toBe(true);
    process.env.COOKIE_SECURE = '0';
    expect(isCookieSecureEnabled()).toBe(false);
  });

  it('pins the anthropic-version default required by C9', () => {
    expect(getAnthropicDefaultVersion()).toBe('2023-06-01');
  });

  it('uses a 5 second budget for the provider probe required by C6', () => {
    expect(getProviderTestTimeoutMs()).toBe(5_000);
  });

  it('parses RELAY_TIMEOUT_MS and falls back on nonsense', () => {
    delete process.env.RELAY_TIMEOUT_MS;
    expect(getRelayTimeoutMs()).toBe(600_000);
    process.env.RELAY_TIMEOUT_MS = '1234';
    expect(getRelayTimeoutMs()).toBe(1234);
    process.env.RELAY_TIMEOUT_MS = 'abc';
    expect(getRelayTimeoutMs()).toBe(600_000);
    process.env.RELAY_TIMEOUT_MS = '0';
    expect(getRelayTimeoutMs()).toBe(600_000);
    process.env.RELAY_TIMEOUT_MS = '-5';
    expect(getRelayTimeoutMs()).toBe(600_000);
  });
});

describe('env: C1/C11 file contracts', () => {
  const root = process.cwd();
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

  it('.env.example documents every variable C1 requires', () => {
    for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
      expect(envExample, name).toMatch(new RegExp(`^${name}=`, 'm'));
    }
    // The template default for DATABASE_PATH must match the code default.
    expect(envExample).toContain(`DATABASE_PATH=${DEFAULT_DATABASE_PATH}`);
    // The template values must satisfy the validators (a 64 hex placeholder and a
    // 32+ character session secret) so a copied .env.local boots.
    const keyLine = envExample.match(/^ENCRYPTION_KEY=(.+)$/m)?.[1] ?? '';
    expect(keyLine).toMatch(/^[0-9a-fA-F]{64}$/);
    const secretLine = envExample.match(/^SESSION_SECRET=(.+)$/m)?.[1] ?? '';
    expect(secretLine.length).toBeGreaterThanOrEqual(32);
  });

  it('.gitignore covers the ops-scripts runtime artifacts and secrets (C11)', () => {
    for (const pattern of ['.dev-server.pid', '.dev-server.port', '.dev-logs/', '.env.local', 'data/']) {
      expect(gitignore, pattern).toContain(pattern);
    }
  });
});
