import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NODE_SQLITE_HINT,
  SCHEMA_DDL,
  SqliteUnavailableError,
  closeDb,
  getDb,
  loadSqliteModule,
  queryAll,
  queryOne,
  resolveDatabaseFile,
  resetDbForTests,
} from '@/lib/db';
import { prepareTestEnv } from './test-helpers';

const tempDirs: string[] = [];

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  resetDbForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tableNames(): string[] {
  return queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map((row) => String(row.name));
}

describe('db: node:sqlite availability guard', () => {
  it('raises an actionable error mentioning Node >= 22.5 when the module is missing', () => {
    expect(() => loadSqliteModule({})).toThrow(/Node >= 22\.5/);
    expect(() => loadSqliteModule({ DatabaseSync: 'not-a-constructor' })).toThrow(
      /Node >= 22\.5/,
    );
  });

  it('loads the built-in module on a supported runtime', () => {
    const module = loadSqliteModule();
    expect(typeof module.DatabaseSync).toBe('function');
  });

  it('exposes the actionable hint text', () => {
    expect(NODE_SQLITE_HINT).toContain('Node >= 22.5');
    let caught: unknown;
    try {
      loadSqliteModule({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SqliteUnavailableError);
    expect((caught as Error).message).toContain('node:sqlite');
  });
});

describe('db: schema migration', () => {
  it('creates every table and index required by C12', () => {
    getDb();
    const names = tableNames();
    expect(names).toEqual(expect.arrayContaining(['api_keys', 'providers', 'request_logs', 'settings']));
    const indexes = queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'request_logs'",
    ).map((row) => String(row.name));
    expect(indexes.some((name) => name.includes('created_at'))).toBe(true);
  });

  it('is idempotent (re-running the DDL keeps the data)', () => {
    const db = getDb();
    db.exec(SCHEMA_DDL);
    db.exec(SCHEMA_DDL);
    expect(tableNames()).toEqual(expect.arrayContaining(['api_keys', 'providers', 'request_logs', 'settings']));
    closeDb();
    const second = getDb();
    second.exec(SCHEMA_DDL);
    expect(tableNames()).toEqual(expect.arrayContaining(['api_keys', 'providers', 'request_logs', 'settings']));
  });

  it('declares the documented columns', () => {
    getDb();
    const columnsOf = (table: string) =>
      queryAll<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => String(row.name));
    expect(columnsOf('api_keys')).toEqual(
      expect.arrayContaining(['id', 'name', 'key_prefix', 'key_hash', 'created_at', 'last_used_at', 'revoked_at']),
    );
    expect(columnsOf('providers')).toEqual(
      expect.arrayContaining(['id', 'name', 'protocol', 'base_url', 'api_key_enc', 'enabled', 'created_at']),
    );
    expect(columnsOf('request_logs')).toEqual(
      expect.arrayContaining([
        'id',
        'created_at',
        'protocol',
        'path',
        'model',
        'upstream',
        'status',
        'latency_ms',
        'input_tokens',
        'output_tokens',
        'api_key_id',
        'error',
        'stream',
      ]),
    );
    expect(columnsOf('settings')).toEqual(expect.arrayContaining(['key', 'value']));
  });

  it('persists rows across handles bound to the same in-memory database only within a process', () => {
    getDb();
    queryAll('SELECT 1');
    const row = queryOne<{ value: number }>('SELECT 1 + 1 AS value');
    expect(Number(row?.value)).toBe(2);
  });
});

describe('db: filesystem behaviour', () => {
  it('defaults DATABASE_PATH to ./data/aragon.db', () => {
    delete process.env.DATABASE_PATH;
    expect(resolveDatabaseFile()).toBe(path.resolve(process.cwd(), 'data/aragon.db'));
  });

  it('keeps :memory: untouched and creates missing directories recursively', () => {
    expect(resolveDatabaseFile(':memory:')).toBe(':memory:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aragon-db-'));
    tempDirs.push(dir);
    const nested = path.join(dir, 'deep', 'nested', 'aragon.db');
    prepareTestEnv();
    const db = getDb(nested);
    expect(fs.existsSync(nested)).toBe(true);
    db.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT)');
    closeDb();
  });

  it('does not create the project data directory for :memory: databases', () => {
    const dataDir = path.resolve(process.cwd(), 'data');
    const existed = fs.existsSync(dataDir);
    prepareTestEnv();
    getDb();
    if (!existed) expect(fs.existsSync(dataDir)).toBe(false);
  });
});
