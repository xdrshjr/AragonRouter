import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Readiness-budget and record-integrity boundary suite for the `ops-scripts` work package.
 *
 * Two acceptance criteria were only ever checked *statically* (a regex over the script
 * source) or through a full `next dev` boot, which is the slowest and most
 * environment-dependent path in the whole suite:
 *
 *   1. "start-dev.ps1 在 120 秒内就绪并打印 URL、PID 与日志路径，实际端口写入
 *      .dev-server.port" — nothing proved the *printed* URL/PID/log path and the recorded
 *      port belong to the same server. Here a stub `npm run dev` (a plain node HTTP server,
 *      no Next.js, no network) is started through the real `scripts/start-dev.ps1`, so the
 *      hand-off between the launcher and whatever the project runs as `dev` is executed for
 *      real, in seconds instead of minutes.
 *   2. The readiness deadline is what implements the 120 s acceptance budget. A `dev`
 *      command that starts but never listens must make the launcher give up *at the
 *      deadline*, kill the tree, remove the records and exit non-zero — instead of hanging
 *      forever or leaving a half-written `.dev-server.port` behind.
 *
 * Every case runs in a throw-away sandbox (own `package.json` with a stubbed `dev` script,
 * own `scripts/`, junction to the real `node_modules`) so the developer's `.env.local`,
 * `.dev-server.*` and `data/` are never touched. The scripts resolve their project root from
 * `$PSScriptRoot`, so each sandbox is a fully independent "repository".
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * A `dev` command that behaves like a started server: it answers the readiness probe the
 * launcher polls (`GET /api/admin/session`) and keeps running until it is killed.
 */
const SERVING_DEV_STUB = `import { createServer } from 'node:http';

const argv = process.argv.slice(2);
function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
const port = Number(flag('-p') ?? flag('--port') ?? '0');
const host = flag('-H') ?? flag('--hostname') ?? '127.0.0.1';
if (!Number.isInteger(port) || port <= 0) {
  console.error('[dev-stub] missing -p <port>; argv=' + JSON.stringify(argv));
  process.exit(2);
}

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: { ok: true }, path: request.url }));
});
server.listen(port, host, () => {
  console.log('[dev-stub] ready on http://' + host + ':' + port);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
`;

/** A `dev` command that starts, never listens on the port and never exits. */
const SILENT_DEV_STUB = `console.log('[dev-stub] started but will never listen');
setInterval(() => {}, 1000);
`;

interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  elapsedMs: number;
}

const sandboxes: string[] = [];
const spawned: (ChildProcessWithoutNullStreams | ReturnType<typeof spawn>)[] = [];

/**
 * Build a disposable "repository" whose `npm run dev` is `dev-stub.mjs` (serving) or
 * `dev-stub-silent.mjs` (never listens). Everything else the launcher needs is copied from
 * the real repository so the code under test is the shipped code, not a re-implementation.
 */
function makeSandbox(mode: 'serving' | 'silent'): string {
  const dir = mkdtempSync(join(tmpdir(), 'aragon-readiness-'));
  sandboxes.push(dir);

  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  manifest.scripts = {
    ...(manifest.scripts ?? {}),
    // `start-dev.ps1` appends `-- -p <port> -H 127.0.0.1`; the stub reads those flags.
    dev: `node ${mode === 'serving' ? 'dev-stub.mjs' : 'dev-stub-silent.mjs'}`,
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'dev-stub.mjs'), SERVING_DEV_STUB, 'utf8');
  writeFileSync(join(dir, 'dev-stub-silent.mjs'), SILENT_DEV_STUB, 'utf8');

  copyFileSync(join(projectRoot, '.env.example'), join(dir, '.env.example'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const script of ['start-dev.ps1', 'stop-dev.ps1']) {
    copyFileSync(join(projectRoot, 'scripts', script), join(dir, 'scripts', script));
  }
  copyFileSync(
    join(projectRoot, 'scripts', 'lib', 'dev-common.ps1'),
    join(dir, 'scripts', 'lib', 'dev-common.ps1'),
  );
  // Assert-Dependencies only looks for node_modules\next\package.json; a junction is enough.
  symlinkSync(join(projectRoot, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return dir;
}

/**
 * Run a bundled script and capture its output through a *file*, not a pipe.
 *
 * A background dev server outlives the launcher and inherits console handles; when the
 * launcher's stdout is a pipe, a surviving grandchild can hold it open and the parent's
 * 'close' event never fires. This is the same reason the shipped `scripts-runtime` suite
 * uses a file transcript for `-KeepServer`. stdio is fully ignored here and PowerShell tees
 * every stream into the file itself.
 */
function runPowerShell(
  scriptPath: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const logDir = join(options.cwd ?? projectRoot, '.dev-logs');
  mkdirSync(logDir, { recursive: true });
  const outFile = join(logDir, `vitest-readiness-${process.pid}-${Date.now()}.log`);
  const argumentList = args
    .map((arg) => (/^-[A-Za-z][A-Za-z0-9]*$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`))
    .join(' ');
  const command =
    `$ErrorActionPreference = 'Continue'; ` +
    `& '${scriptPath}' ${argumentList} *>&1 | Out-File -FilePath '${outFile}' -Encoding utf8; ` +
    `exit $LASTEXITCODE`;
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: options.cwd ?? projectRoot,
    windowsHide: true,
    stdio: 'ignore',
  });
  spawned.push(child);

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 180_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let output = '';
      try {
        // Out-File -Encoding utf8 writes a BOM on Windows PowerShell 5.1.
        output = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
      } catch {
        output = '';
      }
      try {
        rmSync(outFile, { force: true });
      } catch {
        // A handle may still be held briefly on Windows; .dev-logs/ is gitignored anyway.
      }
      resolve({ exitCode: code, output, timedOut, elapsedMs: Date.now() - startedAt });
    });
  });
}

function tcpConnectable(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPortClosed(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpConnectable(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !(await tcpConnectable(port));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

afterAll(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const dir of sandboxes.splice(0)) {
    // Best effort: a surviving stub would keep the sandbox (and a port) alive.
    const pid = Number.parseInt(readTrimmed(join(dir, '.dev-server.pid')), 10);
    if (Number.isInteger(pid) && pid > 4) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The stub already exited.
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold a handle on the junction briefly; the temp dir is disposable.
    }
  }
});

// ---------------------------------------------------------------------------
// 1) Happy path: URL, PID, log path and .dev-server.port must agree with the
//    server that is really serving — verified without booting Next.js.
// ---------------------------------------------------------------------------

describe('scripts/start-dev.ps1 readiness hand-off (acceptance: URL + PID + log path + real port)', () => {
  it(
    'prints URL/PID/log path, records the very port that serves, and stop-dev.ps1 frees it idempotently',
    async () => {
      const dir = makeSandbox('serving');
      const pidFile = join(dir, '.dev-server.pid');
      const portFile = join(dir, '.dev-server.port');
      let port = 0;

      try {
        const start = await runPowerShell(
          join(dir, 'scripts', 'start-dev.ps1'),
          ['-SkipInstall', '-TimeoutSeconds', '60'],
          { cwd: dir, timeoutMs: 150_000 },
        );
        const transcript = start.output;

        expect(start.timedOut, 'start-dev.ps1 did not finish').toBe(false);
        expect(start.exitCode, transcript.slice(-3000)).toBe(0);
        expect(transcript).toContain('开发服务器已就绪。');

        // The three things the acceptance criterion names must be printed.
        const url = /URL\s*:\s*(http:\/\/127\.0\.0\.1:(\d+))/.exec(transcript);
        expect(url, `no URL line in:\n${transcript.slice(-2000)}`).not.toBeNull();
        port = Number.parseInt(url?.[2] ?? '', 10);
        expect(Number.isInteger(port) && port > 0, `unparsable port in ${url?.[1] ?? ''}`).toBe(true);

        const printedPid = /PID\s*:\s*(\d+)/.exec(transcript)?.[1] ?? '';
        expect(printedPid).toMatch(/^\d+$/);

        // The log path must be the documented artefact, not an arbitrary temp file.
        expect(transcript).toContain('.dev-logs');
        expect(transcript).toContain('dev.log');

        // The recorded port is the port that actually answers, and it is not hardcoded
        // (3000 is occupied by an unrelated listener in this environment more often than not).
        expect(readTrimmed(portFile)).toBe(String(port));
        expect(readTrimmed(pidFile)).toBe(printedPid);
        expect(port).toBeGreaterThanOrEqual(3000);
        expect(await tcpConnectable(port), `nothing is serving the recorded port ${port}`).toBe(true);

        // C11: dev output is redirected into .dev-logs/dev.log even in background mode.
        expect(existsSync(join(dir, '.dev-logs', 'dev.log'))).toBe(true);

        // First run generates .env.local with the four C1 fields.
        const env = readFileSync(join(dir, '.env.local'), 'utf8');
        for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
          expect(env, `.env.local is missing ${key}`).toContain(`${key}=`);
        }

        // ---- stop: the port must be released and the records removed ----
        const stop = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], { cwd: dir });
        expect(stop.exitCode, stop.output.slice(-2000)).toBe(0);
        expect(stop.output).toContain('开发服务器已停止。');
        expect(await waitForPortClosed(port), `port ${port} is still open after stop-dev.ps1`).toBe(true);
        expect(existsSync(pidFile), '.dev-server.pid survived the stop').toBe(false);
        expect(existsSync(portFile), '.dev-server.port survived the stop').toBe(false);

        // ---- idempotency: a second stop is a success and says there was nothing to do ----
        const again = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], { cwd: dir });
        expect(again.exitCode, again.output.slice(-2000)).toBe(0);
        expect(again.output).toContain('没有正在运行的开发服务器（无需停止）。');
      } finally {
        // Never leave a stub server behind, even if an assertion threw first.
        await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-Quiet'], { cwd: dir }).catch(
          () => undefined,
        );
      }
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
// 2) The readiness budget is a deadline, not a comment: a `dev` command that
//    never listens must fail at the deadline, kill the tree, clean up and exit 1.
// ---------------------------------------------------------------------------

describe('scripts/start-dev.ps1 readiness deadline (acceptance: bounded wait, never hang)', () => {
  it(
    'gives up at -TimeoutSeconds, reports the deadline, kills the tree and leaves no records behind',
    async () => {
      const dir = makeSandbox('silent');
      const pidFile = join(dir, '.dev-server.pid');
      const portFile = join(dir, '.dev-server.port');

      // 6 s is the smallest budget the parameter accepts (ValidateRange(5, 900)), so these
      // cases stay fast while still exercising the real deadline machinery.
      const start = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-SkipInstall', '-TimeoutSeconds', '6'],
        { cwd: dir, timeoutMs: 150_000 },
      );
      const transcript = start.output;

      expect(start.timedOut, 'start-dev.ps1 hung instead of honouring the deadline').toBe(false);
      expect(start.exitCode, transcript.slice(-3000)).toBe(1);
      expect(transcript).toContain('等待服务就绪（最长 6 秒）');
      expect(transcript).toContain('等待超过 6 秒仍未就绪');
      expect(transcript).toContain('开发服务器未能就绪');

      // A failed start must not leave a half-written record behind (that is what made
      // stop-dev.ps1 target the wrong process in the past).
      expect(existsSync(pidFile), '.dev-server.pid left behind by a failed start').toBe(false);
      expect(existsSync(portFile), '.dev-server.port left behind by a failed start').toBe(false);

      // The dev process the launcher started must be gone, not orphaned.
      const recorded = /已记录 PID=(\d+)/.exec(transcript)?.[1] ?? '';
      expect(recorded).toMatch(/^\d+$/);
      expect(processAlive(Number.parseInt(recorded, 10)), `dev process ${recorded} was left running`).toBe(
        false,
      );

      // Bounded by the deadline, nowhere near an unbounded wait.
      expect(start.elapsedMs).toBeLessThan(120_000);
    },
    300_000,
  );

  it(
    'a stop after a failed start is still a clean silent success, and the shipped default budget stays 120 s',
    async () => {
      const dir = makeSandbox('silent');

      const start = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-SkipInstall', '-TimeoutSeconds', '6'],
        { cwd: dir, timeoutMs: 150_000 },
      );
      expect(start.exitCode, start.output.slice(-2000)).toBe(1);
      expect(start.output).toContain('等待服务就绪（最长 6 秒）');

      // The default value lives in the parameter declaration, so the 120 s acceptance budget
      // is asserted against the shipped source rather than by waiting two minutes.
      const source = readFileSync(join(projectRoot, 'scripts', 'start-dev.ps1'), 'utf8');
      expect(source).toMatch(/\[int\]\$TimeoutSeconds = 120/);
      expect(source).toMatch(/\[ValidateRange\(5, 900\)\]\s*\r?\n\s*\[int\]\$TimeoutSeconds = 120/);

      const stop = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-Quiet'], { cwd: dir });
      expect(stop.exitCode, stop.output.slice(-2000)).toBe(0);
      expect(stop.output.trim(), '-Quiet must print nothing on the success path').toBe('');
      expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
      expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);
    },
    300_000,
  );
});
