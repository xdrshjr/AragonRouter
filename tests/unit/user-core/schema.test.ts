import { beforeEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_DDL,
  closeDb,
  getDb,
  queryAll,
  queryOne,
  resetDbForTests,
} from '@/lib/db';
import { prepareTestEnv } from '../test-helpers';

/**
 * C-SCHEMA: the three account tables and their indexes.
 *
 * The DDL is re-run on every boot, so "can be executed twice on the same
 * in-memory database without an error and without losing rows" is a hard
 * requirement, not a nicety.
 */

beforeEach(() => {
  prepareTestEnv();
});

function tableNames(): string[] {
  return queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map((row) => String(row.name));
}

function columnsOf(table: string): string[] {
  return queryAll<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => String(row.name));
}

function indexesOf(table: string): string[] {
  return queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
    [table],
  ).map((row) => String(row.name));
}

describe('schema: account tables (C-SCHEMA)', () => {
  it('creates users, user_sessions and captcha_challenges next to the gateway tables', () => {
    getDb();
    expect(tableNames()).toEqual(
      expect.arrayContaining([
        'users',
        'user_sessions',
        'captcha_challenges',
        'api_keys',
        'providers',
        'request_logs',
        'settings',
      ]),
    );
  });

  it('declares every documented column', () => {
    getDb();
    expect(columnsOf('users')).toEqual(
      expect.arrayContaining([
        'id',
        'username',
        'username_lower',
        'display_name',
        'password_hash',
        'role',
        'status',
        'created_at',
        'updated_at',
        'last_login_at',
      ]),
    );
    expect(columnsOf('user_sessions')).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'token_hash',
        'created_at',
        'last_seen_at',
        'expires_at',
        'revoked_at',
        'user_agent',
        'ip',
      ]),
    );
    expect(columnsOf('captcha_challenges')).toEqual(
      expect.arrayContaining(['id', 'answer_hash', 'created_at', 'expires_at', 'attempts', 'consumed_at']),
    );
  });

  it('creates the lookup indexes the stores depend on', () => {
    getDb();
    const userIndexes = indexesOf('users').join(' ');
    expect(userIndexes).toMatch(/created_at/);
    expect(userIndexes).toMatch(/role|username/);
    expect(indexesOf('user_sessions').join(' ')).toMatch(/user_id/);
    expect(indexesOf('user_sessions').join(' ')).toMatch(/expires_at/);
    expect(indexesOf('captcha_challenges').join(' ')).toMatch(/expires_at/);
  });

  it('is idempotent: re-running the DDL keeps data and raises nothing', () => {
    const db = getDb();
    expect(() => db.exec(SCHEMA_DDL)).not.toThrow();
    expect(() => db.exec(SCHEMA_DDL)).not.toThrow();

    queryAll(
      `INSERT INTO users
        (id, username, username_lower, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
       VALUES ('u1', 'Alice', 'alice', NULL, 'scrypt$1,1,1$aa$bb', 'admin', 'active', 1, 1, NULL)`,
    );

    // Re-running the migration on a populated database must not drop rows.
    expect(() => db.exec(SCHEMA_DDL)).not.toThrow();
    expect(queryAll('SELECT id FROM users')).toHaveLength(1);

    // A fresh `:memory:` handle (new process, new database) migrates cleanly too.
    closeDb();
    const reopened = getDb();
    expect(() => reopened.exec(SCHEMA_DDL)).not.toThrow();
    expect(tableNames()).toEqual(expect.arrayContaining(['users', 'user_sessions', 'captcha_challenges']));
  });

  it('enforces the role and status domains', () => {
    getDb();
    const insert = (role: string, status: string) =>
      queryAll(
        `INSERT INTO users
          (id, username, username_lower, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, NULL, 'x', ?, ?, 1, 1, NULL)`,
        [role + status, role + status, role + status, role, status],
      );
    expect(() => insert('admin', 'active')).not.toThrow();
    expect(() => insert('member', 'disabled')).not.toThrow();
    expect(() => insert('owner', 'active')).toThrow(/CHECK/i);
    expect(() => insert('admin', 'pending')).toThrow(/CHECK/i);
  });

  it('keeps usernames unique case-insensitively', () => {
    getDb();
    queryAll(
      `INSERT INTO users
        (id, username, username_lower, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
       VALUES ('a', 'Bob', 'bob', NULL, 'x', 'member', 'active', 1, 1, NULL)`,
    );
    expect(() =>
      queryAll(
        `INSERT INTO users
          (id, username, username_lower, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
         VALUES ('b', 'BOB', 'bob', NULL, 'x', 'member', 'active', 2, 2, NULL)`,
      ),
    ).toThrow(/UNIQUE/i);
  });

  it('cascades session rows when a user is deleted', () => {
    const db = getDb();
    db.exec('PRAGMA foreign_keys = ON');
    queryAll(
      `INSERT INTO users
        (id, username, username_lower, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
       VALUES ('u1', 'carol', 'carol', NULL, 'x', 'member', 'active', 1, 1, NULL)`,
    );
    queryAll(
      `INSERT INTO user_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip)
       VALUES ('s1', 'u1', 'hash', 1, 1, 99999, NULL, NULL, NULL)`,
    );
    queryAll('DELETE FROM users WHERE id = ?', ['u1']);
    expect(queryOne('SELECT id FROM user_sessions WHERE id = ?', ['s1'])).toBeUndefined();
  });

  it('starts from an empty database after a reset (test isolation)', () => {
    getDb();
    queryAll(
      `INSERT INTO users
        (id, username, username_lower, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
       VALUES ('u1', 'dave', 'dave', NULL, 'x', 'member', 'active', 1, 1, NULL)`,
    );
    resetDbForTests();
    getDb();
    expect(queryAll('SELECT id FROM users')).toHaveLength(0);
  });
});
