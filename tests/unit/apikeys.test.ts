import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  ApiKeyValidationError,
  createApiKey,
  findActiveApiKey,
  generateApiKey,
  getApiKey,
  hashApiKey,
  isValidApiKeyFormat,
  listApiKeys,
  normalizeKeyName,
  revokeApiKey,
  touchApiKey,
} from '@/lib/apikeys';
import { queryAll, queryOne } from '@/lib/db';
import { prepareTestEnv } from './test-helpers';

beforeEach(() => {
  prepareTestEnv();
});

interface ApiKeyRowShape {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

describe('apikeys: generation', () => {
  it('produces ar-<32 hex> keys with a prefix and a sha256 hash', () => {
    const generated = generateApiKey();
    expect(generated.key).toMatch(/^ar-[0-9a-f]{32}$/);
    expect(generated.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(generated.prefix).toBe(generated.key.slice(0, 10));
    expect(generated.hash).toBe(hashApiKey(generated.key));
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.hash).not.toContain(generated.key);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 25 }, () => generateApiKey().key));
    expect(keys.size).toBe(25);
  });

  it('validates the key format', () => {
    expect(isValidApiKeyFormat(generateApiKey().key)).toBe(true);
    expect(isValidApiKeyFormat('ar-')).toBe(false);
    expect(isValidApiKeyFormat('sk-0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isValidApiKeyFormat('ar-0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(isValidApiKeyFormat(undefined)).toBe(false);
  });
});

describe('apikeys: persistence', () => {
  it('stores only the hash and never returns it again', () => {
    const created = createApiKey('ci-runner', 'key-1');
    expect(created.key).toMatch(/^ar-[0-9a-f]{32}$/);
    expect(created.public).toMatchObject({
      id: 'key-1',
      name: 'ci-runner',
      keyPrefix: created.key.slice(0, 10),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(created.public.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = queryOne<ApiKeyRowShape>('SELECT * FROM api_keys WHERE id = ?', ['key-1']);
    expect(row?.key_hash).toBe(hashApiKey(created.key));
    expect(row?.key_prefix).toBe(created.key.slice(0, 10));
    // The plaintext is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(created.key);
  });

  it('lists keys without hash or plaintext', () => {
    const first = createApiKey('alpha', 'key-a', 1_700_000_000_000);
    createApiKey('beta', 'key-b', 1_700_000_001_000);
    const list = listApiKeys();
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe('beta');
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('key_hash');
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toContain(first.key);
    expect(Object.keys(first.public).sort()).toEqual(
      ['createdAt', 'id', 'keyPrefix', 'lastUsedAt', 'name', 'revokedAt'].sort(),
    );
  });

  it('resolves a presented key to its row and rejects unknown ones', () => {
    const created = createApiKey('lookup', 'key-lookup');
    expect(findActiveApiKey(created.key)).toEqual({ id: 'key-lookup', name: 'lookup' });
    expect(findActiveApiKey(generateApiKey().key)).toBeNull();
    expect(findActiveApiKey('not-a-key')).toBeNull();
  });

  it('soft revokes: the row survives, the key stops working', () => {
    const created = createApiKey('revocable', 'key-rev');
    expect(revokeApiKey('key-rev', 1_700_000_500_000)).toBe(true);
    const row = queryOne<ApiKeyRowShape>('SELECT * FROM api_keys WHERE id = ?', ['key-rev']);
    expect(row?.revoked_at).toBe(1_700_000_500_000);
    expect(findActiveApiKey(created.key)).toBeNull();
    expect(getApiKey('key-rev')?.revokedAt).toBe(new Date(1_700_000_500_000).toISOString());

    // Revoking twice keeps the original timestamp and still reports success.
    expect(revokeApiKey('key-rev', 1_800_000_000_000)).toBe(true);
    expect(queryOne<ApiKeyRowShape>('SELECT * FROM api_keys WHERE id = ?', ['key-rev'])?.revoked_at).toBe(
      1_700_000_500_000,
    );
    expect(revokeApiKey('missing')).toBe(false);
  });

  it('records last usage without throwing', () => {
    createApiKey('touch', 'key-touch');
    touchApiKey('key-touch', 1_700_000_700_000);
    expect(queryOne<ApiKeyRowShape>('SELECT * FROM api_keys WHERE id = ?', ['key-touch'])?.last_used_at).toBe(
      1_700_000_700_000,
    );
    expect(() => touchApiKey('does-not-exist')).not.toThrow();
  });

  it('rejects invalid names', () => {
    expect(() => normalizeKeyName('')).toThrow(ApiKeyValidationError);
    expect(() => normalizeKeyName('   ')).toThrow(ApiKeyValidationError);
    expect(() => normalizeKeyName(42)).toThrow(ApiKeyValidationError);
    expect(() => normalizeKeyName('x'.repeat(65))).toThrow(ApiKeyValidationError);
    expect(normalizeKeyName('  padded name  ')).toBe('padded name');
    expect(normalizeKeyName('bel\u0000l')).toBe('bell');
    expect(() => createApiKey(undefined, 'bad')).toThrow(ApiKeyValidationError);
    expect(queryAll('SELECT * FROM api_keys')).toHaveLength(0);
  });
});
