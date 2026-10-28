import { execute, queryOne } from '@/lib/db';
import { REGISTRATION_ENABLED_KEY, type RegistrationSetting } from '@/lib/types';

/**
 * Key/value application settings (WP1 · 注册开关).
 *
 * The `settings` table already existed for the gateway; this module is the single
 * typed accessor so routes never hand-roll `SELECT value FROM settings`.
 *
 * Convention (C-SCHEMA): the value column stores `'1'` / `'0'`, and a **missing
 * row means the feature is enabled** - a fresh install must let the first user
 * register without an extra migration step.
 */

const TRUTHY = '1';
const FALSY = '0';

/** Raw read: `null` when the key has never been written. */
export function readSetting(key: string): string | null {
  const row = queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? String(row.value) : null;
}

/** Upsert a raw value. Only used by the typed helpers below. */
export function writeSetting(key: string, value: string): void {
  execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/** Remove a key so it falls back to its default. */
export function deleteSetting(key: string): boolean {
  return execute('DELETE FROM settings WHERE key = ?', [key]).changes > 0;
}

/**
 * Whether self-service registration is open.
 * Missing row, empty value or any unrecognised value => enabled (the documented
 * default), because a broken settings row must not silently lock everyone out.
 */
export function isRegistrationEnabled(): boolean {
  return readSetting(REGISTRATION_ENABLED_KEY) !== FALSY;
}

/** Toggle registration and return the persisted state. */
export function setRegistrationEnabled(enabled: boolean): boolean {
  writeSetting(REGISTRATION_ENABLED_KEY, enabled ? TRUTHY : FALSY);
  return isRegistrationEnabled();
}

/** DTO helper so a route can answer `{data:{enabled:boolean}}` in one call. */
export function getRegistrationSetting(): RegistrationSetting {
  return { enabled: isRegistrationEnabled() };
}

/**
 * Assert that registration may proceed.
 * @throws RegistrationClosedError when an admin has disabled sign-ups.
 */
export function assertRegistrationOpen(): void {
  if (!isRegistrationEnabled()) throw new RegistrationClosedError();
}

export class RegistrationClosedError extends Error {
  constructor(message = 'registration is disabled by the administrator') {
    super(message);
    this.name = 'RegistrationClosedError';
  }
}
