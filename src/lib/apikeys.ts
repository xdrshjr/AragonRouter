import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@/lib/crypto';
import { queryAll, queryOne, execute, type SqliteValue } from '@/lib/db';
import type { ApiKeyPublic } from '@/lib/types';

/** API keys are `ar-` followed by 32 lowercase hex characters. */
export const API_KEY_PREFIX = 'ar-';
export const API_KEY_RANDOM_BYTES = 16;
const API_KEY_PATTERN = /^ar-[0-9a-f]{32}$/;
const PREFIX_LENGTH = 10;
const NAME_MAX_LENGTH = 64;

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** SHA-256 of the plaintext key: the only representation that touches the database. */
export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

/** Structural check used before hashing an incoming header value. */
export function isValidApiKeyFormat(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_PATTERN.test(value);
}

/**
 * Create a fresh key. The plaintext is never persisted - only its SHA-256 hash
 * and a short, non-secret prefix used by the console for identification.
 */
export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString('hex')}`;
  return { key, prefix: key.slice(0, PREFIX_LENGTH), hash: hashApiKey(key) };
}

function toPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(Number(row.last_used_at)).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(),
  };
}

export class ApiKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

/** Trim and validate a human readable key name. */
export function normalizeKeyName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiKeyValidationError('name is required and must be a string');
  }
  // Strip control characters: names are rendered in the console and stored verbatim.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) throw new ApiKeyValidationError('name must not be empty');
  if (name.length > NAME_MAX_LENGTH) {
    throw new ApiKeyValidationError(`name must be at most ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

export interface CreateApiKeyResult {
  public: ApiKeyPublic;
  key: string;
}

export function createApiKey(name: unknown, id: string, now: number = Date.now()): CreateApiKeyResult {
  const normalized = normalizeKeyName(name);
  const generated = generateApiKey();
  execute(
    'INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
    [id, normalized, generated.prefix, generated.hash, now],
  );
  const row = queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
  if (!row) throw new Error('failed to persist the api key');
  return { public: toPublic(row), key: generated.key };
}

export function listApiKeys(): ApiKeyPublic[] {
  const rows = queryAll<ApiKeyRow>(
    'SELECT id, name, key_prefix, key_hash, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC, id DESC',
  );
  return rows.map(toPublic);
}

export function getApiKey(id: string): ApiKeyPublic | null {
  const row = queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
  return row ? toPublic(row) : null;
}

/**
 * Soft revoke (C5). Returns false when the key does not exist; revoking twice is
 * idempotent and keeps the original `revoked_at` timestamp.
 */
export function revokeApiKey(id: string, now: number = Date.now()): boolean {
  const existing = queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
  if (!existing) return false;
  if (existing.revoked_at !== null) return true;
  execute('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, id]);
  return true;
}

export interface AuthenticatedApiKey {
  id: string;
  name: string;
}

/**
 * Resolve a plaintext key to its row. Revoked keys resolve to null.
 * Uses a hash lookup, so the comparison happens inside SQLite on the digest.
 */
export function findActiveApiKey(plaintext: string): AuthenticatedApiKey | null {
  if (!isValidApiKeyFormat(plaintext)) return null;
  const row = queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', [
    hashApiKey(plaintext),
  ] as SqliteValue[]);
  if (!row || row.revoked_at !== null) return null;
  return { id: row.id, name: row.name };
}

/** Record usage so the console can show `lastUsedAt`. Best effort, never throws. */
export function touchApiKey(id: string, now: number = Date.now()): void {
  try {
    execute('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, id]);
  } catch {
    // usage accounting must never break a relay
  }
}
