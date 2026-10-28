import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import {
  NODE_SQLITE_HINT,
  SqliteUnavailableError,
  closeDb,
  getDb,
  loadSqliteModule,
  queryOne,
  resolveDatabaseFile,
  type SqliteValue,
} from '@/lib/db';
import { prepareTestEnv } from './test-helpers';

/**
 * WP1 · toolchain skeleton acceptance.
 *
 * The rest of the suite exercises behaviour; these cases pin the *deliverables*
 * that the spec names explicitly (package.json scripts/deps, tsconfig strict +
 * `@/*` paths, vitest node environment, the `/` -> `/console` redirect, the
 * .gitignore coverage) so a silent regression in the skeleton fails the build
 * instead of surfacing weeks later.
 */

const root = process.cwd();

/**
 * The `data/` directory is a documented *runtime* artifact, not a build output:
 * `.env.example` / C12 default `DATABASE_PATH` to `./data/aragon.db`, and
 * `scripts/start-dev.ps1` / `scripts/test-api.ps1` create it on a normal run. A
 * developer (or CI job) that has already exercised the product therefore has
 * `data/` on disk, and the unit suite must stay green in that state.
 *
 * So the offline guarantee is pinned the way a behaviour is pinned: snapshot the
 * workspace *before* the run and compare it afterwards. A `data/` that already
 * existed must not fail the suite; a `data/` (or a database file inside it) that
 * this run created must — that is the signal a test opened the real database
 * instead of the `:memory:` one.
 */
const dataDirAtImport = fs.existsSync(path.join(root, 'data'));

function dataArtifactSnapshot(): string[] {
  const dir = path.join(root, 'data');
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const parent = entry.parentPath ?? (entry as unknown as { path: string }).path;
      return path.relative(dir, path.join(parent, entry.name)).split(path.sep).join('/');
    })
    .sort();
  return entries;
}

const dataArtifactsAtImport = dataArtifactSnapshot();

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;
}

/**
 * "After" half of the snapshot: once every case in this file has run, the runtime
 * artifacts under `data/` must look exactly like they did at import time. This
 * runs before any other file's teardown, so it pins *this* file's behaviour; the
 * per-case assertion inside the offline block covers the same invariant while it
 * is actionable (a failing case points at the test that broke it).
 */
afterAll(() => {
  expect(fs.existsSync(path.join(root, 'data'))).toBe(dataDirAtImport);
  expect(dataArtifactSnapshot()).toEqual(dataArtifactsAtImport);
});

describe('toolchain: package.json (spec item 1)', () => {
  const pkg = readJson('package.json');
  const scripts = pkg.scripts as Record<string, string>;
  const deps = pkg.dependencies as Record<string, string>;
  const devDeps = pkg.devDependencies as Record<string, string>;

  it('exposes the four documented scripts', () => {
    expect(scripts.dev).toBe('next dev');
    expect(scripts.build).toBe('next build');
    expect(scripts.typecheck).toBe('tsc --noEmit');
    expect(scripts.test).toBe('vitest run');
  });

  it('pins the runtime dependencies required by the spec', () => {
    expect(deps.next).toMatch(/^\^?15\./);
    expect(deps.react).toMatch(/^\^?19\./);
    expect(deps['react-dom']).toMatch(/^\^?19\./);
    for (const name of ['lucide-react', 'clsx', 'tailwind-merge']) {
      expect(deps[name], name).toBeTruthy();
    }
  });

  it('pins the build-time dependencies required by the spec', () => {
    expect(devDeps.typescript).toBeTruthy();
    expect(devDeps['@types/node']).toMatch(/^\^?22\./);
    expect(devDeps['@types/react']).toBeTruthy();
    expect(devDeps['@types/react-dom']).toBeTruthy();
    expect(devDeps.tailwindcss).toMatch(/^\^?3\.4/);
    expect(devDeps.postcss).toBeTruthy();
    expect(devDeps.autoprefixer).toBeTruthy();
    expect(devDeps.vitest).toBeTruthy();
  });

  it('does not depend on next/font (C10 requires the system font stack)', () => {
    // Scan the modules Next actually compiles. Only a real `import`/`require` of
    // the module counts: a comment that *mentions* next/font (documenting that the
    // system font stack is used instead) must not fail the check, otherwise the
    // assertion punishes the very documentation C10 asks for.
    const nextFontUse = /(?:from|import|require)\s*\(?\s*['"]next\/font(?:\/[a-z]+)?['"]/;
    const appSources: string[] = [];
    for (const dir of ['src/app', 'src/components']) {
      const absolute = path.join(root, dir);
      if (!fs.existsSync(absolute)) continue;
      for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(tsx?|css|mjs)$/.test(entry.name)) continue;
        const parent = entry.parentPath ?? (entry as unknown as { path: string }).path;
        appSources.push(path.join(parent, entry.name));
      }
    }
    for (const file of appSources) {
      const source = fs.readFileSync(file, 'utf8');
      expect(nextFontUse.test(source), file).toBe(false);
    }
  });
});

describe('toolchain: tsconfig.json / vitest.config.ts', () => {
  it('enables strict mode and maps @/* to src/*', () => {
    const tsconfig = readJson('tsconfig.json');
    const options = tsconfig.compilerOptions as Record<string, unknown>;
    expect(options.strict).toBe(true);
    expect(options.noEmit).toBe(true);
    expect(options.paths).toMatchObject({ '@/*': ['./src/*'] });
    const include = tsconfig.include as string[];
    expect(include).toEqual(expect.arrayContaining(['**/*.ts', '**/*.tsx']));
    expect(tsconfig.exclude as string[]).toEqual(expect.arrayContaining(['node_modules', '.next']));
  });

  it('runs vitest in the node environment against tests/unit with the @ alias', () => {
    const config = fs.readFileSync(path.join(root, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("environment: 'node'");
    expect(config).toContain("include: ['tests/unit/**/*.test.ts']");
    expect(config).toContain("'@': srcDir");
  });

  it('redirects / to /console and hardens response headers (next.config.ts)', async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: '/', destination: '/console' })]),
    );
    const headers = await nextConfig.headers?.();
    const flat = (headers ?? []).flatMap((entry) => entry.headers.map((header) => `${header.key}: ${header.value}`));
    expect(flat.join('\n')).toMatch(/X-Content-Type-Options: nosniff/);
    expect(flat.join('\n')).toMatch(/X-Frame-Options: DENY/);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe('toolchain: API route surface (C-ROUTE-INVENTORY: 22 routes under src/app/api)', () => {
  /**
   * C-ROUTE-INVENTORY: every documented handler, relative to `src/app/api`, with `/`
   * separators. The list is the contract `auth-api` publishes and `admin-users-api`
   * consumes, so it is asserted as an exact set: a missing route breaks the console,
   * and a stray `route.ts` is an undocumented endpoint that nobody reviews.
   */
  const EXPECTED_ROUTES = [
    'admin/keys/route.ts',
    'admin/keys/[id]/route.ts',
    'admin/logs/route.ts',
    'admin/providers/route.ts',
    'admin/providers/[id]/route.ts',
    'admin/providers/[id]/test/route.ts',
    'admin/session/route.ts',
    'admin/settings/route.ts',
    'admin/stats/route.ts',
    'admin/users/route.ts',
    'admin/users/[id]/route.ts',
    'admin/users/[id]/password/route.ts',
    'admin/users/[id]/sessions/[sessionId]/route.ts',
    'auth/captcha/route.ts',
    'auth/login/route.ts',
    'auth/logout/route.ts',
    'auth/password/route.ts',
    'auth/register/route.ts',
    'auth/session/route.ts',
    'v1/chat/completions/route.ts',
    'v1/messages/route.ts',
    'v1/models/route.ts',
  ].sort();

  function discoverRoutes(): string[] {
    const apiRoot = path.join(root, 'src/app/api');
    expect(fs.existsSync(apiRoot)).toBe(true);
    return fs
      .readdirSync(apiRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'route.ts')
      .map((entry) => {
        const parent = entry.parentPath ?? (entry as unknown as { path: string }).path;
        return path.relative(apiRoot, path.join(parent, entry.name)).split(path.sep).join('/');
      })
      .sort();
  }

  it('keeps exactly the 22 documented route handlers in place', () => {
    const routes = discoverRoutes();
    // A deleted route (or a stray one) must fail the build, not the console.
    expect(routes).toEqual(EXPECTED_ROUTES);
    expect(routes).toHaveLength(22);
  });

  it('inventories the six account routes and the five admin user-management routes', () => {
    const routes = discoverRoutes();
    expect(routes.filter((route) => route.startsWith('auth/'))).toEqual([
      'auth/captcha/route.ts',
      'auth/login/route.ts',
      'auth/logout/route.ts',
      'auth/password/route.ts',
      'auth/register/route.ts',
      'auth/session/route.ts',
    ]);
    expect(
      routes.filter(
        (route) => route.startsWith('admin/users') || route === 'admin/settings/route.ts',
      ),
    ).toEqual([
        'admin/settings/route.ts',
        'admin/users/[id]/password/route.ts',
        'admin/users/[id]/route.ts',
        'admin/users/[id]/sessions/[sessionId]/route.ts',
        'admin/users/route.ts',
      ]);
  });

  it('keeps the automation entry point at /api/admin/session (no captcha added there)', () => {
    // `scripts/test-api.ps1` and the CI smoke tests post `{password}` there; requiring a
    // captcha would break every automated client silently, so its absence is pinned.
    const source = fs.readFileSync(
      path.join(root, 'src/app/api/admin/session/route.ts'),
      'utf8',
    );
    expect(source).toMatch(/export async function POST/);
    expect(source).not.toMatch(/captcha/i);
  });

  it('declares the shared runtime/segment config on every account route', () => {
    for (const route of [
      'auth/captcha/route.ts',
      'auth/login/route.ts',
      'auth/logout/route.ts',
      'auth/password/route.ts',
      'auth/register/route.ts',
      'auth/session/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(root, 'src/app/api', route), 'utf8');
      // `nodejs` because the store is `node:sqlite`; `force-dynamic` because a cached
      // session answer would show a signed-out user to a signed-in one.
      expect(source, route).toContain("export const runtime = 'nodejs'");
      expect(source, route).toContain("export const dynamic = 'force-dynamic'");
    }
  });
});

describe('toolchain: offline unit tests', () => {
  beforeEach(() => {
    prepareTestEnv();
  });

  afterEach(() => {
    closeDb();
  });

  it('runs the whole suite against an in-memory database', () => {
    // vitest.config / prepareTestEnv() point every suite at `:memory:`; nothing the
    // suite does may reach the real `./data/aragon.db` (C12 default).
    expect(process.env.DATABASE_PATH).toBe(':memory:');
    expect(resolveDatabaseFile()).toBe(':memory:');
  });

  it('never leaves a real database file behind', () => {
    // Behavioural half: ask the live handle where it lives. A memory-backed
    // database reports an empty file for its `main` schema, so this fails loudly if
    // a future refactor ever silently opens the on-disk default instead.
    const handle = getDb();
    const schema = queryOne<{ name: string; file: string }>(
      'PRAGMA database_list',
      [],
      handle,
    ) as { name?: SqliteValue; file?: SqliteValue } | undefined;
    expect(schema?.name).toBe('main');
    expect(String(schema?.file ?? '')).toBe('');
  });

  it('creates no new runtime artifacts under data/ (workspace snapshot)', () => {
    // Opening the configured database must be a no-op on disk: `getDb()` already ran
    // in the case above, and `ensureDirectory()` is skipped for `:memory:`.
    expect(() => getDb()).not.toThrow();
    // A `data/` left behind by `scripts/start-dev.ps1` / `scripts/test-api.ps1` (or a
    // previous local run) is a documented runtime artifact and must not fail the
    // suite; a `data/` this run created must.
    expect(fs.existsSync(path.join(root, 'data'))).toBe(dataDirAtImport);
    expect(dataArtifactSnapshot()).toEqual(dataArtifactsAtImport);
  });

  it('never performs a live network call from the unit suite', () => {
    const files = fs
      .readdirSync(path.join(root, 'tests/unit'))
      .filter((name) => name.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = fs.readFileSync(path.join(root, 'tests/unit', name), 'utf8');
      // A hard-coded public host in a test would only work with live traffic.
      expect(source, name).not.toMatch(/fetch\(\s*['"`]https:\/\/(?!api\.(anthropic|openai)\.com)/);
    }
  });
});

describe('db: node:sqlite guard is reachable through getDb (acceptance)', () => {
  beforeEach(() => {
    prepareTestEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    closeDb();
  });

  it('throws the actionable Node >= 22.5 error instead of crashing when the module is absent', () => {
    closeDb();
    const runtime = process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown };
    const original = runtime.getBuiltinModule;
    const ownRequire = Object.getOwnPropertyDescriptor(globalThis, 'require');
    Object.defineProperty(globalThis, 'require', { value: undefined, configurable: true });
    runtime.getBuiltinModule = () => undefined;
    try {
      let caught: unknown;
      try {
        getDb(':memory:');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SqliteUnavailableError);
      expect((caught as Error).message).toContain('Node >= 22.5');
      expect((caught as Error).message).toContain('node:sqlite');
      expect((caught as Error).message).toContain('node --version');
      expect(NODE_SQLITE_HINT).toBe((caught as Error).message);
    } finally {
      runtime.getBuiltinModule = original;
      if (ownRequire) Object.defineProperty(globalThis, 'require', ownRequire);
      else Reflect.deleteProperty(globalThis, 'require');
    }

    // The guard is not sticky: the next call works again.
    expect(typeof loadSqliteModule().DatabaseSync).toBe('function');
    expect(() => getDb(':memory:')).not.toThrow();
  });
});
