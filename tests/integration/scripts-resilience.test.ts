import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Boundary suite for the `ops-scripts` work package.
 *
 * Two gaps were left open by the existing suites:
 *
 *  1. **Corrupted runtime records.** `.dev-server.pid` / `.dev-server.port` are written by
 *     a killed run or edited by hand often enough that the parsing helpers have to turn
 *     junk into "no record" instead of throwing — and the stop path still has to exit 0
 *     and clean the artefacts up (acceptance: idempotent stop, artefacts removed).
 *  2. **The README is part of this work package, the routes are not.** Every `curl`
 *     example the Chinese README shows an operator has to hit a real `route.ts` under
 *     `src/app/api` that really exports that HTTP method, otherwise the documented
 *     contract (C2/C3/C4/C5/C6/C7/C8) has drifted away from `gw-hardening`'s code. That
 *     is a cross-module boundary: documented before, verified against the code here.
 *
 * Nothing here boots a Next.js server; the PowerShell cases run `stop-dev.ps1` inside a
 * throw-away sandbox so the developer's `.env.local` / `.dev-server.*` are never touched.
 */

// `fileURLToPath(new URL('../..'))` keeps a trailing separator, which would make every
// `file.slice(projectRoot.length + 1)` off by one; normalise it before any slicing.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '');

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const sandboxes: string[] = [];
const spawned: ChildProcessWithoutNullStreams[] = [];

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aragon-resilience-'));
  sandboxes.push(dir);
  // A package.json of its own: `Resolve-ProjectRoot` must never wander up into an
  // unrelated ancestor directory.
  copyFileSync(join(projectRoot, 'package.json'), join(dir, 'package.json'));
  copyFileSync(join(projectRoot, '.env.example'), join(dir, '.env.example'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const script of ['start-dev.ps1', 'stop-dev.ps1', 'test-api.ps1']) {
    copyFileSync(join(projectRoot, 'scripts', script), join(dir, 'scripts', script));
  }
  copyFileSync(
    join(projectRoot, 'scripts', 'lib', 'dev-common.ps1'),
    join(dir, 'scripts', 'lib', 'dev-common.ps1'),
  );
  return dir;
}

function runPowerShell(
  scriptPath: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { cwd: options.cwd ?? projectRoot, windowsHide: true },
  );
  spawned.push(child);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

afterAll(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const dir of sandboxes.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold a handle briefly; the temp directory is disposable.
    }
  }
});

// ---------------------------------------------------------------------------
// 1) Corrupted runtime records must read as "nothing recorded"
// ---------------------------------------------------------------------------

describe('scripts/stop-dev.ps1 with corrupted runtime records', () => {
  it(
    'treats junk in .dev-server.pid / .dev-server.port as "no record", exits 0 and cleans both files',
    async () => {
      const dir = makeSandbox();
      // Shapes a killed or hand-edited run can leave behind.
      writeFileSync(join(dir, '.dev-server.pid'), '\n  "not-a-pid"  \n', 'utf8');
      writeFileSync(join(dir, '.dev-server.port'), 'port=3000abc\n', 'utf8');

      const stop = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], { cwd: dir });

      expect(stop.timedOut).toBe(false);
      expect(stop.exitCode, `stop-dev.ps1 output: ${stop.stdout}${stop.stderr}`).toBe(0);
      // Junk must never be reported as a live server nor as a failure.
      expect(stop.stdout).not.toContain('停止失败');
      expect(stop.stdout).not.toContain('停止过程中出现问题');
      expect(stop.stdout).toMatch(/(未找到|已不存在)/);
      expect(existsSync(join(dir, '.dev-server.pid')), 'corrupted pid record must be removed').toBe(false);
      expect(existsSync(join(dir, '.dev-server.port')), 'corrupted port record must be removed').toBe(false);
    },
    120_000,
  );

  it(
    'is still idempotent on a second run, and -Quiet really is silent on the success path',
    async () => {
      const dir = makeSandbox();
      writeFileSync(join(dir, '.dev-server.port'), '3000abc\n', 'utf8');
      const first = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-Quiet'], { cwd: dir });
      const second = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-Quiet'], { cwd: dir });
      expect(first.exitCode, `first -Quiet run: ${first.stdout}${first.stderr}`).toBe(0);
      expect(second.exitCode, `second -Quiet run: ${second.stdout}${second.stderr}`).toBe(0);
      expect(first.stdout.trim(), '-Quiet must print nothing on success').toBe('');
      expect(second.stdout.trim(), '-Quiet must print nothing on success').toBe('');
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 2) README curl examples vs the real route handlers (cross-module docs boundary)
// ---------------------------------------------------------------------------

interface DocumentedCall {
  method: string;
  path: string;
  line: number;
}

interface RouteModule {
  file: string;
  segments: string[];
  methods: string[];
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Parse every `curl` invocation in the README, honouring cmd.exe `^` continuations. */
function readmeCurlCalls(): DocumentedCall[] {
  const lines = readFileSync(join(projectRoot, 'README.md'), 'utf8').split(/\r?\n/);
  const calls: DocumentedCall[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    // `noUncheckedIndexedAccess` is on in this repo, so every index read has to be narrowed.
    const line = lines[index];
    if (line === undefined || !/\bcurl\b/.test(line)) continue;
    let invocation = line;
    let cursor = index;
    while (/\^\s*$/.test(invocation) && cursor + 1 < lines.length) {
      cursor += 1;
      invocation = `${invocation.replace(/\^\s*$/, ' ')} ${lines[cursor] ?? ''}`;
    }
    const url = /https?:\/\/[^\s"']+/.exec(invocation);
    if (!url) continue;
    const path = (url[0] ?? '').replace(/^https?:\/\/[^/]+/, '').split('?')[0]?.replace(/\/+$/, '') ?? '';
    if (!path.startsWith('/api/')) continue;
    const methodMatch = /(?:-X|--request)\s+([A-Za-z]+)/.exec(invocation);
    // curl's documented default: any body flag (`-d`, `--data`, `--data-raw`, `-F`, ...)
    // turns the request into a POST; without one it is a GET. The README relies on this
    // for the relay examples, which are written as `curl ... -d "{...}"`.
    const hasBody = /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|-F|--form|-T|--upload-file)\s/.test(
      invocation,
    );
    const fallbackMethod = hasBody ? 'POST' : 'GET';
    calls.push({
      method: methodMatch ? (methodMatch[1] ?? fallbackMethod).toUpperCase() : fallbackMethod,
      path,
      line: index + 1,
    });
  }
  return calls;
}

function walkRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walkRouteFiles(full));
    else if (entry === 'route.ts') files.push(full);
  }
  return files;
}

function discoverRoutes(): RouteModule[] {
  const appDir = join(projectRoot, 'src', 'app');
  return walkRouteFiles(join(appDir, 'api')).map((file) => {
    const relative = file.slice(appDir.length + 1).split(sep);
    relative.pop(); // drop `route.ts`
    const source = readFileSync(file, 'utf8');
    const methods = HTTP_METHODS.filter((method) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`).test(source),
    );
    return { file: file.slice(projectRoot.length + 1), segments: relative, methods };
  });
}

function matchesRoute(routeSegments: string[], documentedSegments: string[]): boolean {
  if (routeSegments.length !== documentedSegments.length) return false;
  return routeSegments.every((segment, index) =>
    segment.startsWith('[') && segment.endsWith(']') ? true : segment === documentedSegments[index],
  );
}

describe('README.md curl examples point at route handlers that exist', () => {
  const calls = readmeCurlCalls();
  const routes = discoverRoutes();

  it('extracts the documented calls and finds every API route module', () => {
    // Guards the extractor: if the README or the routes moved, this suite must not pass
    // by comparing empty sets. (The README currently documents 19 API calls across 11 routes.)
    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(routes.length).toBeGreaterThanOrEqual(11);
    const documentedPaths = new Set(calls.map((call) => call.path));
    for (const required of [
      '/api/admin/session',
      '/api/admin/keys',
      '/api/admin/providers',
      '/api/admin/logs',
      '/api/admin/stats',
      '/api/v1/messages',
      '/api/v1/chat/completions',
      '/api/v1/models',
    ]) {
      expect(documentedPaths, `README must document ${required}`).toContain(required);
    }
  });

  it('every documented call resolves to a route file exporting that HTTP method', () => {
    const unresolved: string[] = [];
    for (const call of calls) {
      const documentedSegments = call.path.split('/').filter((segment) => segment.length > 0);
      const route = routes.find((candidate) => matchesRoute(candidate.segments, documentedSegments));
      if (!route) {
        unresolved.push(`README:${call.line} ${call.method} ${call.path} -> no route.ts`);
        continue;
      }
      if (!route.methods.includes(call.method)) {
        unresolved.push(
          `README:${call.line} ${call.method} ${call.path} -> ${route.file} exports [${route.methods.join(', ')}]`,
        );
      }
    }
    expect(unresolved, `documented calls with no matching handler:\n${unresolved.join('\n')}`).toEqual([]);
  });

  it('never presents a hardcoded port as the dev-server port', () => {
    const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
    // The examples may use a port, but the README must say the printed/recorded port wins
    // (acceptance: the port is never hardcoded, it is read from .dev-server.port).
    expect(readme).toMatch(/以实际打印为准|以实际打印的端口为准|端口.*实际.*为准/);
    expect(readme).toContain('.dev-server.port');
  });
});
