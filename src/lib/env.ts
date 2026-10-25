/**
 * Runtime environment resolution.
 *
 * Every secret is read lazily (per call) rather than at module scope so that:
 *  - `next build` never needs real credentials;
 *  - tests can stub `process.env` per test case.
 */

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function readRaw(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 32+ character HMAC secret for the admin session cookie. */
export function getSessionSecret(): string {
  const secret = readRaw('SESSION_SECRET');
  if (!secret) {
    throw new ConfigurationError(
      'SESSION_SECRET is not set. Add a random value of at least 32 characters to .env.local (see .env.example).',
    );
  }
  if (secret.length < 32) {
    throw new ConfigurationError(
      `SESSION_SECRET must be at least 32 characters (got ${secret.length}). Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }
  return secret;
}

/** 64 hex characters == 32 bytes for AES-256-GCM. */
export function getEncryptionKeyHex(): string {
  const key = readRaw('ENCRYPTION_KEY');
  if (!key) {
    throw new ConfigurationError(
      'ENCRYPTION_KEY is not set. Add 64 hex characters (32 bytes) to .env.local. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new ConfigurationError(
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return key.toLowerCase();
}

/** Admin console password (plain comparison, constant time). */
export function getAdminPassword(): string {
  const password = readRaw('ADMIN_PASSWORD');
  if (!password) {
    throw new ConfigurationError(
      'ADMIN_PASSWORD is not set. Add the admin console password to .env.local (see .env.example).',
    );
  }
  return password;
}

export const DEFAULT_DATABASE_PATH = './data/aragon.db';

/** SQLite file location; `:memory:` is passed through untouched. */
export function getDatabasePath(): string {
  return readRaw('DATABASE_PATH') ?? DEFAULT_DATABASE_PATH;
}

/** Cookie `Secure` flag is opt-in so that plain-HTTP local development works. */
export function isCookieSecureEnabled(): boolean {
  const raw = readRaw('COOKIE_SECURE');
  return raw === '1' || raw === 'true';
}

export function getAnthropicDefaultVersion(): string {
  return '2023-06-01';
}

/** Hard cap for a single relay call (streaming included). */
export function getRelayTimeoutMs(): number {
  const raw = readRaw('RELAY_TIMEOUT_MS');
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

export function getProviderTestTimeoutMs(): number {
  return 5_000;
}

/**
 * Upper bound for an inbound client request body.
 *
 * Any holder of an `ar-...` key can POST to the relay, so an unbounded read would
 * let a single client exhaust the server's memory. Anthropic/OpenAI chat payloads
 * are far below this (a 128k-token prompt is ~1 MiB of UTF-8).
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export function getMaxRequestBodyBytes(): number {
  const raw = readRaw('MAX_REQUEST_BODY_BYTES');
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

/**
 * Upper bound (bytes) for a *non-streaming* upstream response that the relay holds
 * in memory to extract token usage. Larger bodies are passed through as a stream
 * instead of being buffered (see `relay`).
 */
export const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024 * 1024;

export function getMaxBufferedResponseBytes(): number {
  const raw = readRaw('MAX_BUFFERED_RESPONSE_BYTES');
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
}
