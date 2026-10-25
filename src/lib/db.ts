import fs from 'node:fs';
import path from 'node:path';
import { getDatabasePath } from '@/lib/env';

/**
 * Minimal structural types for `node:sqlite`.
 *
 * They are declared locally (instead of relying on `@types/node`) so that the
 * data layer keeps compiling on every Node 22 minor release, where the sqlite
 * type declarations are still experimental and keep changing.
 */
export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
  all(...params: SqliteValue[]): Record<string, SqliteValue>[];
  get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined;
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string, options?: { readBigInts?: boolean }) => SqliteDatabase;
}

export class SqliteUnavailableError extends Error {
  constructor(message: string = NODE_SQLITE_HINT) {
    super(message);
    this.name = 'SqliteUnavailableError';
  }
}

/**
 * Actionable error text required by the acceptance criteria: it must mention the
 * minimum supported Node.js version.
 */
export const NODE_SQLITE_HINT =
  'node:sqlite is unavailable in this Node.js runtime. AragonRouter requires Node >= 22.5 (check `node --version`). ' +
  'Upgrade Node.js to 22.5 or newer (the sqlite module ships built in), or start Node with --experimental-sqlite on 22.5+ builds that still gate it.';

/**
 * Inline schema (C12). Deliberately a string and not a `.sql` file: Next.js server
 * bundling does not copy arbitrary asset files next to the compiled handler.
 *
 * Every statement is idempotent, so running the migration on each boot is safe.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic', 'openai')),
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  path TEXT NOT NULL,
  model TEXT,
  upstream TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  api_key_id TEXT,
  error TEXT,
  stream INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key_id ON request_logs (api_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`.trim();

/**
 * Load `node:sqlite` without a static ESM import, so that a missing module turns
 * into the actionable {@link NODE_SQLITE_HINT} instead of a bundler/runtime crash.
 *
 * `injected` exists purely for tests (pass `{}` to simulate an unsupported Node).
 */
export function loadSqliteModule(injected?: unknown): SqliteModule {
  let resolved: unknown = injected;
  if (resolved === undefined) {
    const runtime = process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    };
    if (typeof runtime.getBuiltinModule === 'function') {
      try {
        resolved = runtime.getBuiltinModule('node:sqlite');
      } catch {
        resolved = undefined;
      }
    }
    if (resolved === undefined) {
      // Fallback for CJS bundles / older runtimes.
      const req = (globalThis as { require?: (id: string) => unknown }).require;
      if (typeof req === 'function') {
        try {
          resolved = req('node:sqlite');
        } catch {
          resolved = undefined;
        }
      }
    }
  }
  const DatabaseSync = (resolved as { DatabaseSync?: unknown } | undefined)?.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    throw new SqliteUnavailableError();
  }
  return { DatabaseSync: DatabaseSync as SqliteModule['DatabaseSync'] };
}

/** `:memory:` stays untouched; everything else becomes an absolute path. */
export function resolveDatabaseFile(location: string = getDatabasePath()): string {
  if (location === ':memory:' || location.startsWith('file:')) return location;
  return path.isAbsolute(location) ? location : path.resolve(process.cwd(), location);
}

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
];

let cached: { file: string; db: SqliteDatabase } | null = null;

function ensureDirectory(file: string): void {
  if (file === ':memory:' || file.startsWith('file:')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function migrate(db: SqliteDatabase): void {
  for (const pragma of PRAGMAS) {
    try {
      db.exec(pragma);
    } catch {
      // WAL is unavailable on some filesystems (network shares, read-only mounts);
      // the database still works with the default journal mode.
    }
  }
  db.exec(SCHEMA_DDL);
}

/**
 * Singleton database handle bound to `DATABASE_PATH`.
 * The directory is created on demand and the schema is applied idempotently.
 */
export function getDb(location?: string): SqliteDatabase {
  const file = resolveDatabaseFile(location);
  if (cached && cached.file === file) return cached.db;
  if (cached) {
    try {
      cached.db.close();
    } catch {
      // ignore: the old handle may already be closed
    }
    cached = null;
  }
  ensureDirectory(file);
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(file);
  try {
    migrate(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw error;
  }
  cached = { file, db };
  return db;
}

/** Close the cached connection (used by tests and graceful shutdown). */
export function closeDb(): void {
  if (!cached) return;
  try {
    cached.db.close();
  } finally {
    cached = null;
  }
}

/** Test hook: drop the cached handle so the next call re-reads DATABASE_PATH. */
export function resetDbForTests(): void {
  closeDb();
}

const statementCache = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>();

function prepare(db: SqliteDatabase, sql: string): SqliteStatement {
  let perDb = statementCache.get(db);
  if (!perDb) {
    perDb = new Map();
    statementCache.set(db, perDb);
  }
  let statement = perDb.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    perDb.set(sql, statement);
  }
  return statement;
}

export function queryAll<T = Record<string, SqliteValue>>(
  sql: string,
  params: SqliteValue[] = [],
  db: SqliteDatabase = getDb(),
): T[] {
  return prepare(db, sql).all(...params) as unknown as T[];
}

export function queryOne<T = Record<string, SqliteValue>>(
  sql: string,
  params: SqliteValue[] = [],
  db: SqliteDatabase = getDb(),
): T | undefined {
  return prepare(db, sql).get(...params) as unknown as T | undefined;
}

export function execute(
  sql: string,
  params: SqliteValue[] = [],
  db: SqliteDatabase = getDb(),
): { changes: number; lastInsertRowid: number } {
  const result = prepare(db, sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/** Guard for writing `undefined` into a nullable column. */
export function nullable<T>(value: T | undefined | null): T | null {
  return value === undefined ? null : value;
}
