import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, Socket } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Concurrency and failure-path regressions for the ops-scripts work package.
 *
 * Everything here runs in a throw-away sandbox: a temp directory holding a copy of
 * `package.json`, `.env.example`, `scripts/` and a *fake* `npm run dev` target
 * (`node fake-dev-server.mjs`), so a "dev server" is a tiny HTTP listener that boots in
 * milliseconds instead of a full Next.js compile. The scripts resolve their project root
 * from `$PSScriptRoot`, so the developer's `.env.local`, `.dev-server.*` records and
 * `data/` are never touched.
 *
 * Covered defects (both found in review):
 *
 *  1. Concurrent `start-dev.ps1` invocations used to start two `next dev` servers: the
 *     records (`.dev-server.pid` / `.dev-server.port`) were written only after readiness
 *     and there was no lock, so the later run overwrote the records and the earlier
 *     server became an unmanaged orphan that `stop-dev.ps1` happily reported as
 *     "already stopped" (exit 0) while it kept listening. Now the whole
 *     "check → start → record" window is serialised on a named mutex, the port owner is
 *     re-verified before the stop path is ever asked to trust the records, and
 *     `stop-dev.ps1` additionally scans the port range for repo-owned listeners that the
 *     records do not mention.
 *  2. `test-api.ps1` failure semantics were only covered for the *first* assertion
 *     failing. Mid-run failure (the stub upstream dying, or the run being aborted once
 *     the server is up) is covered in `scripts-runtime.test.ts`, which drives the real
 *     Next.js server; the sandbox cases here keep this file fast.
 *
 * Earlier, still-relevant gaps kept here: `Find-FreePort` really chooses a port from 3000
 * upwards (not just "the script mentions the function"), and `stop-dev.ps1 -PurgeLogs`
 * versus the default "keep the logs".
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const projectCommon = join(projectRoot, 'scripts', 'lib', 'dev-common.ps1');

/** Range the scripts scan/allocate from. Mirrors the scripts' own defaults. */
const PORT_RANGE_START = 3000;
const PORT_RANGE_SPAN = 50;

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const sandboxes: string[] = [];
const spawned: ChildProcessWithoutNullStreams[] = [];

/**
 * The fake `npm run dev` target. It understands `-p <port>` exactly like `next dev`, binds
 * loopback only and answers every request with JSON, which is all `start-dev.ps1`'s
 * readiness probe (`GET /api/admin/session`) needs.
 *
 * The sandbox directory is baked into the command line on purpose: it is the ownership
 * evidence `stop-dev.ps1` demands before it kills anything, and it lets the tests find
 * "our" listeners the same way an operator would.
 */
const FAKE_DEV_SERVER = `import http from 'node:http';

const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-p' || args[i] === '--port') port = Number.parseInt(args[i + 1], 10) || 0;
}
if (!port) {
  process.stderr.write('fake dev server: missing -p <port>\\n');
  process.exit(2);
}
http
  .createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { ok: true, url: request.url } }));
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write('fake dev server listening on ' + port + '\\n');
  });
`;

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aragon-races-'));
  sandboxes.push(dir);
  copyFileSync(join(projectRoot, '.env.example'), join(dir, '.env.example'));
  // `Resolve-ProjectRoot` walks up from <root>\scripts looking for package.json, so the
  // sandbox must have one of its own: without it the scripts would legitimately refuse to
  // run (and must never wander up into an unrelated ancestor directory).
  copyFileSync(join(projectRoot, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const script of ['start-dev.ps1', 'stop-dev.ps1', 'test-api.ps1']) {
    copyFileSync(join(projectRoot, 'scripts', script), join(dir, 'scripts', script));
  }
  copyFileSync(projectCommon, join(dir, 'scripts', 'lib', 'dev-common.ps1'));
  return dir;
}

/**
 * Sandbox whose `npm run dev` starts {@link FAKE_DEV_SERVER} instead of Next.js.
 * `node_modules/next/package.json` is stubbed because that is all `Assert-Dependencies`
 * checks for, so `-SkipInstall` is satisfied without symlinking the real node_modules.
 */
function makeStartSandbox(): string {
  const dir = makeSandbox();
  mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'next', 'package.json'), '{}\n', 'utf8');
  writeFileSync(join(dir, 'fake-dev-server.mjs'), FAKE_DEV_SERVER, 'utf8');
  const pkg = {
    name: 'aragon-router',
    version: '0.0.0',
    private: true,
    // The sandbox path is part of the command line: it is the ownership proof the stop
    // script requires, and it makes the test's own listener scan unambiguous.
    scripts: { dev: `node fake-dev-server.mjs "${dir}"` },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return dir;
}

function collect(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<RunResult> {
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
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
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
  return collect(child, options.timeoutMs ?? 240_000);
}

let sandboxRunCounter = 0;

/**
 * Run a script whose output must be captured through a *file*.
 *
 * `start-dev.ps1` leaves a background dev server running: that grandchild inherits the
 * parent's stdout pipe, so `close` on a piped child may never fire. PowerShell itself
 * tees both streams into a file (`*>&1 | Out-File`) and the child is spawned with
 * `stdio: 'ignore'`, so nothing is inherited and the exit code still comes from the
 * script. The transcript is written *inside the sandbox* so the repository's
 * `.dev-logs/` stays untouched.
 */
function runScriptToFile(
  scriptPath: string,
  args: string[] = [],
  options: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  sandboxRunCounter += 1;
  const outFile = join(options.cwd, `script-run-${sandboxRunCounter}.log`);
  const argumentList = args
    // A quoted '-Switch' would bind positionally, so switches stay bare and any other
    // value is single-quoted.
    .map((arg) => (/^-[A-Za-z][A-Za-z0-9]*$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`))
    .join(' ');
  const command =
    `$ErrorActionPreference = 'Continue'; ` +
    `& '${scriptPath}' ${argumentList} *>&1 | Out-File -FilePath '${outFile}' -Encoding utf8; ` +
    `exit $LASTEXITCODE`;
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: 'ignore',
  });

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }, options.timeoutMs ?? 240_000);
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
      resolve({ exitCode: code, stdout: output, stderr: '', timedOut });
    });
  });
}

/** Run a PowerShell snippet that dot-sources dev-common.ps1 (side-effect free). */
function runSnippet(script: string, timeoutMs = 60_000): Promise<RunResult> {
  const command = `$ErrorActionPreference = 'Stop'; . '${projectCommon}'; ${script}`;
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: projectRoot,
    windowsHide: true,
  });
  spawned.push(child);
  return collect(child, timeoutMs);
}

async function occupyPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('no port'));
    });
  });
  return { port, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function tcpConnectable(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** A port from the scripts' own allocation window that nothing is listening on right now. */
async function findFreePortInRange(): Promise<number> {
  for (let candidate = PORT_RANGE_START; candidate < PORT_RANGE_START + PORT_RANGE_SPAN; candidate += 1) {
    const probe = createServer();
    const free = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (free) {
      await closeServer(probe);
      return candidate;
    }
  }
  throw new Error(`no free port in ${PORT_RANGE_START}-${PORT_RANGE_START + PORT_RANGE_SPAN - 1}`);
}

/**
 * Listening ports of every process whose command line mentions `dir`.
 *
 * Deliberately independent of `scripts/lib/dev-common.ps1`: if the scripts' own helper were
 * broken, using it here would make the regression test agree with the bug. CIM for the
 * command lines (the ownership evidence) plus `Get-NetTCPConnection` for the sockets.
 */
function sandboxListenerPorts(dir: string): Promise<number[]> {
  const quoted = dir.replace(/'/g, "''");
  const command =
    `$root = '${quoted}'; ` +
    `$rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) }); ` +
    `$pids = @($rows.ProcessId); ` +
    `if ($pids.Count -eq 0) { '' } else { ` +
    `$list = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess }); ` +
    `(@($list | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object) -join ',') }`;
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('close', () => {
      const ports = out
        .trim()
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve(ports);
    });
  });
}

/**
 * Start a dev-server-shaped node listener on a port from the scan range.
 *
 * `sandboxPathArgument` is an extra argv entry: it puts the sandbox path into the process
 * command line, which is what "belongs to this repository" means for the stop script.
 * Pass `null` to simulate a listener from *another* project (no ownership evidence).
 */
async function startRangeListener(
  sandboxPathArgument: string | null,
  options: { respond?: string } = {},
): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const body = options.respond ?? 'orphan';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await findFreePortInRange();
    const script =
      `require('http').createServer(function(q,s){s.writeHead(200);s.end('${body}')})` +
      `.listen(${port},'127.0.0.1',function(){console.log('listening')})`;
    const args = ['-e', script];
    if (sandboxPathArgument !== null) args.push(join(sandboxPathArgument, 'fake-next-dev.mjs'));
    const child = spawn(process.execPath, args, { windowsHide: true });
    spawned.push(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('listener did not report readiness')), 15_000);
        child.stdout?.on('data', (chunk: string) => {
          if (chunk.includes('listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`listener exited early with code ${code}`));
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      if (!(await tcpConnectable(port))) throw new Error(`listener never answered on ${port}`);
      return { port, child };
    } catch (error) {
      lastError = error;
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  throw new Error(`could not start a listener in the scan range: ${String(lastError)}`);
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

/** Resolve with the exit code, or `null` if the process is still alive after `timeoutMs`. */
function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 20_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Existence check via signal 0 (works on Windows too). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
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

describe('scripts/lib/dev-common.ps1 Find-FreePort (acceptance: port chosen from 3000 upwards)', () => {
  it('skips ports that are already taken and returns the next bindable one', async () => {
    const first = await occupyPort();
    try {
      const result = await runSnippet(`Find-FreePort -StartPort ${first.port} -Attempts 12`);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);

      const chosen = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isFinite(chosen)).toBe(true);
      // It must move upwards from the start port instead of returning it.
      expect(chosen).toBeGreaterThan(first.port);
      expect(chosen).toBeLessThanOrEqual(first.port + 11);
      // And the answer has to be truthful: nothing is listening there.
      expect(await tcpConnectable(chosen, 400), `Find-FreePort returned a busy port ${chosen}`).toBe(false);

      // The returned port must be bindable right now, not merely "not listening".
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(chosen, '127.0.0.1', () => resolve());
      });
      await closeServer(probe);
    } finally {
      await closeServer(first.server);
    }
  }, 120_000);

  it('reports 0 instead of guessing when the whole scan range is taken', async () => {
    const first = await occupyPort();
    try {
      // Attempts=1 makes the scan range exactly the occupied port.
      const result = await runSnippet(`Find-FreePort -StartPort ${first.port} -Attempts 1`);
      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe('0');
    } finally {
      await closeServer(first.server);
    }
  }, 120_000);

  it('rejects an out-of-range start port with 0 instead of throwing', async () => {
    const result = await runSnippet('Find-FreePort -StartPort 0 -Attempts 5');
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe('0');
  }, 60_000);
});

describe('scripts/start-dev.ps1 concurrency (regression: two simultaneous starts left an unmanaged orphan)', () => {
  it('serialises concurrent starts into ONE server and ONE record, and stop-dev.ps1 then frees it', async () => {
    const dir = makeStartSandbox();
    const startScript = join(dir, 'scripts', 'start-dev.ps1');
    const stopScript = join(dir, 'scripts', 'stop-dev.ps1');
    const portFile = join(dir, '.dev-server.port');
    const pidFile = join(dir, '.dev-server.pid');

    // Exactly the reported reproduction: two invocations inside the readiness window.
    const [first, second] = await Promise.all([
      runScriptToFile(startScript, ['-SkipInstall'], { cwd: dir, timeoutMs: 240_000 }),
      runScriptToFile(startScript, ['-SkipInstall'], { cwd: dir, timeoutMs: 240_000 }),
    ]);

    expect(first.timedOut, `first timed out:\n${first.stdout}`).toBe(false);
    expect(second.timedOut, `second timed out:\n${second.stdout}`).toBe(false);
    expect(first.exitCode, `first:\n${first.stdout}`).toBe(0);
    expect(second.exitCode, `second:\n${second.stdout}`).toBe(0);

    // The regression: only one server may be listening, and the records must describe it.
    expect(existsSync(portFile), 'no .dev-server.port was written').toBe(true);
    const recordedPort = Number.parseInt(readFileSync(portFile, 'utf8').trim(), 10);
    expect(Number.isInteger(recordedPort) && recordedPort > 0).toBe(true);
    expect(readFileSync(pidFile, 'utf8').trim()).toMatch(/^\d+$/);
    const recordedPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);

    const listeners = await sandboxListenerPorts(dir);
    expect(listeners, 'concurrent starts left more than one dev server listening').toEqual([recordedPort]);
    expect(await tcpConnectable(recordedPort), 'the recorded port is not serving').toBe(true);

    // One of the two must have waited for the lock and then reused the running instance,
    // instead of starting a second one.
    const combined = `${first.stdout}\n${second.stdout}`;
    expect(combined).toContain('开发服务器已在运行');
    expect(combined).toMatch(/等待 \d+ ms 后拿到锁/);
    const readinessBanners = combined.match(/开发服务器已就绪。/g) ?? [];
    expect(readinessBanners.length, 'more than one instance reported itself as ready').toBe(1);
    // The mutex must be named and derivable, so both invocations provably serialise.
    expect(combined).toContain('获取启动互斥量');

    // stop-dev.ps1 must really free the single server it now knows about.
    const stop = await runScriptToFile(stopScript, [], { cwd: dir, timeoutMs: 120_000 });
    expect(stop.exitCode, stop.stdout).toBe(0);
    expect(await sandboxListenerPorts(dir)).toEqual([]);
    expect(processAlive(recordedPid), `recorded dev PID ${recordedPid} is still alive after stop-dev.ps1`).toBe(false);
    expect(existsSync(portFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);

    // ... and stay idempotent.
    const again = await runScriptToFile(stopScript, [], { cwd: dir, timeoutMs: 120_000 });
    expect(again.exitCode, again.stdout).toBe(0);
  }, 600_000);

  it('does not start a second server when the lock cannot be acquired in time', async () => {
    const dir = makeStartSandbox();
    const startScript = join(dir, 'scripts', 'start-dev.ps1');
    const stopScript = join(dir, 'scripts', 'stop-dev.ps1');

    // Hold the very same mutex from PowerShell (same derivation: project root path).
    const holder = runSnippet(
      `$root = '${dir.replace(/'/g, "''")}'; $lock = Enter-DevLock -ProjectRoot $root -TimeoutSeconds 5; ` +
        `Write-Output ("acquired=" + $lock.Acquired); Start-Sleep -Seconds 40; Exit-DevLock -Lock $lock | Out-Null`,
      120_000,
    );

    // Give the holder time to actually take the lock before the start script asks for it.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const result = await runScriptToFile(startScript, ['-SkipInstall', '-LockTimeoutSeconds', '5'], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    const holderResult = await holder;

    // Precondition: without a real lock holder the rest of this case proves nothing.
    expect(holderResult.stdout, `lock holder output:\n${holderResult.stdout}\n${holderResult.stderr}`).toContain(
      'acquired=True',
    );

    // A refusal, not a second server: non-zero exit, an explanation, and no dev listener.
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.stdout).toContain('等待启动互斥量超时');
    expect(await sandboxListenerPorts(dir)).toEqual([]);
    expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
    expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);

    // Nothing to stop, and stopping stays clean (idempotent).
    const stop = await runScriptToFile(stopScript, [], { cwd: dir, timeoutMs: 120_000 });
    expect(stop.exitCode, stop.stdout).toBe(0);
  }, 300_000);
});

describe('scripts/stop-dev.ps1 unrecorded listener scan (regression: exit 0 while a dev server still listened)', () => {
  it('finds and stops a repo-owned dev listener that the records do not mention', async () => {
    const dir = makeSandbox();
    const stopScript = join(dir, 'scripts', 'stop-dev.ps1');
    const { port, child } = await startRangeListener(dir);
    expect(existsSync(join(dir, '.dev-server.port')), 'the fixture must be unrecorded').toBe(false);

    try {
      const stop = await runScriptToFile(stopScript, [], { cwd: dir, timeoutMs: 120_000 });

      // The old build printed "开发服务器已停止" and exited 0 while this server kept running.
      expect(stop.exitCode, stop.stdout).toBe(0);
      expect(stop.stdout).toContain('已确认属于本仓库');
      expect(stop.stdout).toContain(`端口 ${port}`);
      expect(stop.stdout).toContain('未记录的 dev 进程');
      // The process itself must be gone. (A bare TCP probe is not used here: the test files
      // run in parallel, so another suite's dev server may legitimately grab the freed port
      // the instant it is released, which would look like a survivor.)
      expect(await waitForExit(child), 'the unrecorded dev listener survived stop-dev.ps1').not.toBeNull();
      expect(await sandboxListenerPorts(dir)).toEqual([]);

      // Idempotent: a second run has nothing left to do.
      const again = await runScriptToFile(stopScript, [], { cwd: dir, timeoutMs: 120_000 });
      expect(again.exitCode, again.stdout).toBe(0);
    } finally {
      stopChild(child);
    }
  }, 300_000);

  it('leaves an unrecorded listener from another project alone (no ownership evidence)', async () => {
    const dir = makeSandbox();
    const stopScript = join(dir, 'scripts', 'stop-dev.ps1');
    // Same shape (node.exe listening in the scan range) but its command line never mentions
    // the sandbox, so it is indistinguishable from another project's `next start`.
    const { port, child } = await startRangeListener(null, { respond: 'foreign project' });

    try {
      const stop = await runScriptToFile(stopScript, [], { cwd: dir, timeoutMs: 120_000 });
      expect(stop.exitCode, stop.stdout).toBe(0);
      expect(stop.stdout).toContain('跳过');
      expect(child.exitCode, 'stop-dev.ps1 killed another project\'s process').toBeNull();
      expect(await tcpConnectable(port), 'the foreign listener is no longer reachable').toBe(true);
    } finally {
      stopChild(child);
    }
  }, 300_000);
});

describe('scripts/stop-dev.ps1 log handling', () => {
  it('keeps .dev-logs by default and only deletes it with -PurgeLogs', async () => {
    const dir = makeSandbox();
    const logDir = join(dir, '.dev-logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'dev.log'), 'ready\n', 'utf8');

    const plain = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], { cwd: dir, timeoutMs: 60_000 });
    expect(plain.exitCode, plain.stdout).toBe(0);
    // Default keeps the transcript for post-mortem analysis.
    expect(existsSync(join(logDir, 'dev.log'))).toBe(true);

    const purge = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-PurgeLogs'], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(purge.exitCode, purge.stdout).toBe(0);
    expect(existsSync(logDir), '.dev-logs survived -PurgeLogs').toBe(false);

    // -PurgeLogs stays idempotent: nothing left to stop, nothing left to delete.
    const again = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-PurgeLogs'], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(again.exitCode, again.stdout).toBe(0);
  }, 180_000);

  it('records nothing but still cleans the artefacts when -NoPortScan is used', async () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, '.dev-server.port'), '39999\n', 'utf8');
    const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), ['-NoPortScan'], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain('-NoPortScan');
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.dev-server'))).toEqual([]);
  }, 180_000);
});
