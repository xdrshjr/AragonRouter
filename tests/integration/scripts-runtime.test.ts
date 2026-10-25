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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, Socket } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * Runtime tests for the failure paths of scripts/start-dev.ps1 and
 * scripts/stop-dev.ps1 that the happy-path e2e run (`scripts/test-api.ps1`) never
 * reaches: first-run .env.local generation, `-SkipInstall`, the Node < 22.5 hard
 * gate, stop idempotency with a stale PID, the port-based fallback killing a dev
 * process, and the same fallback *refusing* to kill an unrelated program.
 *
 * Every case runs in a throw-away sandbox: a temp directory holding a copy of
 * `package.json`, `.env.example` and `scripts/`, plus a junction to the real
 * `node_modules` when dependencies are supposed to look installed. The scripts
 * resolve their project root from `$PSScriptRoot`, so nothing here touches the
 * developer's `.env.local`, `.dev-server.*` files or the repository's data/.
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const LISTENER_SCRIPT = fileURLToPath(new URL('./port-listener.ps1', import.meta.url));

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const sandboxes: string[] = [];
const spawned: ChildProcessWithoutNullStreams[] = [];

function makeSandbox(options: { withNodeModules?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aragon-scripts-'));
  sandboxes.push(dir);
  copyFileSync(join(projectRoot, 'package.json'), join(dir, 'package.json'));
  copyFileSync(join(projectRoot, '.env.example'), join(dir, '.env.example'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(projectRoot, 'scripts', 'start-dev.ps1'), join(dir, 'scripts', 'start-dev.ps1'));
  copyFileSync(join(projectRoot, 'scripts', 'stop-dev.ps1'), join(dir, 'scripts', 'stop-dev.ps1'));
  copyFileSync(
    join(projectRoot, 'scripts', 'lib', 'dev-common.ps1'),
    join(dir, 'scripts', 'lib', 'dev-common.ps1'),
  );
  if (options.withNodeModules !== false) {
    // A junction is enough: Assert-Dependencies only looks for node_modules\next\package.json.
    symlinkSync(join(projectRoot, 'node_modules'), join(dir, 'node_modules'), 'junction');
  }
  return dir;
}

/** Run a bundled script the way the README tells an operator to run it. */
function runPowerShell(
  scriptPath: string,
  args: string[] = [],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      {
        cwd: options.cwd ?? projectRoot,
        env: { ...process.env, ...(options.env ?? {}) },
        windowsHide: true,
      },
    );
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

/**
 * Run a bundled script and capture its output through a *file* instead of a pipe.
 *
 * `-KeepServer` intentionally leaves a dev server running, and a surviving grandchild can
 * keep an inherited stdout pipe open — the parent's 'close' event then never fires and the
 * test would hang for no good reason. So this helper starts powershell with `stdio: 'ignore'`
 * and lets PowerShell itself tee every stream into a file (`*>&1 | Out-File`); nothing is
 * inherited from this process, and the exit code still comes from the script.
 */
function runPowerShellToFile(
  scriptPath: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const logDir = join(projectRoot, '.dev-logs');
  mkdirSync(logDir, { recursive: true });
  const outFile = join(logDir, `vitest-${process.pid}-${Date.now()}.log`);
  const argumentList = args
    // A quoted '-Switch' would be passed as a string and bound positionally, so switches
    // are emitted bare while any other value is single-quoted.
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

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 600_000);
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
      // The transcript is only needed for assertions; never accumulate it in .dev-logs/.
      try {
        rmSync(outFile, { force: true });
      } catch {
        // A handle may still be held briefly on Windows; .dev-logs/ is gitignored anyway.
      }
      resolve({ exitCode: code, stdout: output, stderr: '', timedOut });
    });
  });
}

/** Start the foreign-process stand-in and resolve with its bound port. */
async function startForeignListener(): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LISTENER_SCRIPT, '-LifetimeSeconds', '90'],
    { windowsHide: true },
  );
  spawned.push(child);
  child.stdout.setEncoding('utf8');
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('listener did not report a port in 20s')), 20_000);
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const first = buffer.split(/\r?\n/)[0]?.trim();
      if (first && /^\d+$/.test(first)) {
        clearTimeout(timer);
        resolve(Number.parseInt(first, 10));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`listener exited early with code ${code}`));
    });
  });
  return { port, child };
}

/** Occupy a port in-process (used to make start-dev.ps1 reject an explicit -Port). */
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

function readEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    map.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return map;
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

afterAll(() => {
  for (const dir of sandboxes.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a handle on the junction briefly; the temp dir is disposable.
    }
  }
});

describe('scripts/start-dev.ps1 first run (C1 .env.local generation)', () => {
  it('creates .env.local with all four fields, prints the password, and never reuses the sample secrets', async () => {
    const dir = makeSandbox();
    const occupied = await occupyPort();
    try {
      const result = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-Port', String(occupied.port), '-SkipInstall'],
        { cwd: dir, timeoutMs: 120_000 },
      );

      // The occupied port aborts the run *after* .env.local was generated: exactly
      // the first-run sequence, without starting a second dev server.
      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stdout).toContain('已被占用');

      const envPath = join(dir, '.env.local');
      expect(existsSync(envPath), 'start-dev.ps1 did not create .env.local').toBe(true);

      const raw = readFileSync(envPath, 'utf8');
      // No BOM: dotenv would otherwise fold it into the first key name.
      expect(raw.charCodeAt(0)).not.toBe(0xfeff);

      const env = readEnvFile(envPath);
      for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
        expect(env.has(key), `.env.local is missing ${key}`).toBe(true);
      }
      const password = env.get('ADMIN_PASSWORD') ?? '';
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(['change-me-in-env-local', 'changeme', 'password', 'admin', 'replace-me']).not.toContain(
        password.toLowerCase(),
      );
      expect((env.get('SESSION_SECRET') ?? '').length).toBeGreaterThanOrEqual(32);
      expect(env.get('SESSION_SECRET')).not.toContain('replace-me');
      // C1: 64 hex characters, and not the public all-zero sample from .env.example.
      expect(env.get('ENCRYPTION_KEY')).toMatch(/^[0-9a-f]{64}$/);
      expect(env.get('ENCRYPTION_KEY')).not.toBe('0'.repeat(64));
      expect(env.get('DATABASE_PATH')).toBe('./data/aragon.db');

      // The operator must be able to log in: the printed password is the stored one.
      expect(result.stdout).toContain('管理口令 ADMIN_PASSWORD');
      const printed = /管理口令 ADMIN_PASSWORD\s*:\s*(\S+)/.exec(result.stdout)?.[1] ?? '';
      expect(printed).toBe(password);

      // The comment header tells the operator the file is gitignored and resettable.
      expect(raw).toContain('.gitignore');
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);

  it('generates fresh random secrets on every fresh sandbox (no fixed defaults)', async () => {
    const dirs = [makeSandbox(), makeSandbox()];
    const occupied = await occupyPort();
    try {
      const values = [];
      for (const dir of dirs) {
        const result = await runPowerShell(
          join(dir, 'scripts', 'start-dev.ps1'),
          ['-Port', String(occupied.port), '-SkipInstall'],
          { cwd: dir, timeoutMs: 120_000 },
        );
        expect(result.exitCode).toBe(1);
        values.push(readEnvFile(join(dir, '.env.local')));
      }
      expect(values[0]?.get('ADMIN_PASSWORD')).not.toBe(values[1]?.get('ADMIN_PASSWORD'));
      expect(values[0]?.get('SESSION_SECRET')).not.toBe(values[1]?.get('SESSION_SECRET'));
      expect(values[0]?.get('ENCRYPTION_KEY')).not.toBe(values[1]?.get('ENCRYPTION_KEY'));
    } finally {
      await closeServer(occupied.server);
    }
  }, 240_000);

  it('regenerates a weak ADMIN_PASSWORD (not on any denylist) and explains why (regression)', async () => {
    const dir = makeSandbox();
    // 10 characters, not a placeholder, so a name-list-only check would call it "usable"
    // and the operator would then face 400/401 at login with no actionable hint.
    writeFileSync(join(dir, '.env.local'), 'ADMIN_PASSWORD=shortpw123\n', 'utf8');
    const occupied = await occupyPort();
    try {
      const result = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-Port', String(occupied.port), '-SkipInstall'],
        { cwd: dir, timeoutMs: 120_000 },
      );
      // The occupied port aborts the run after the env bootstrap, which is what we assert on.
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);

      const env = readEnvFile(join(dir, '.env.local'));
      const password = env.get('ADMIN_PASSWORD') ?? '';
      expect(password, 'weak password was not rotated').not.toBe('shortpw123');
      expect(password.length).toBeGreaterThanOrEqual(12);

      // The diagnostic must name the requirement, not just "invalid password".
      expect(result.stdout).toContain('低于脚本要求的 12 位下限');
      expect(result.stdout).toContain('已重新生成');
      // And the printed password must be the stored one, so the operator can actually log in.
      const printed = /管理口令 ADMIN_PASSWORD\s*:\s*([A-Za-z0-9_-]{12,})/.exec(result.stdout)?.[1] ?? '';
      expect(printed).toBe(password);
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);

  it('regenerates an ADMIN_PASSWORD that cannot round-trip through .env.local (contains #)', async () => {
    const dir = makeSandbox();
    // Length is fine and it is not a placeholder, but the value would be truncated by the
    // dotenv parser, so login would fail for a reason that looks unrelated to the password.
    writeFileSync(join(dir, '.env.local'), 'ADMIN_PASSWORD=p@ss#word-123456\n', 'utf8');
    const occupied = await occupyPort();
    try {
      const result = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-Port', String(occupied.port), '-SkipInstall'],
        { cwd: dir, timeoutMs: 120_000 },
      );
      expect(result.exitCode, `stdout:\n${result.stdout}`).toBe(1);
      const env = readEnvFile(join(dir, '.env.local'));
      const password = env.get('ADMIN_PASSWORD') ?? '';
      expect(password).not.toBe('p@ss#word-123456');
      expect(password).toMatch(/^[A-Za-z0-9_-]{12,}$/);
      expect(result.stdout).toContain('含有');
      expect(result.stdout).toContain('已重新生成');
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);

  it('keeps a strong existing ADMIN_PASSWORD instead of rotating it', async () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, '.env.local'), 'ADMIN_PASSWORD=Strong-Pass-2026-x\n', 'utf8');
    const occupied = await occupyPort();
    try {
      const result = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-Port', String(occupied.port), '-SkipInstall'],
        { cwd: dir, timeoutMs: 120_000 },
      );
      expect(result.exitCode, `stdout:\n${result.stdout}`).toBe(1);
      const env = readEnvFile(join(dir, '.env.local'));
      expect(env.get('ADMIN_PASSWORD')).toBe('Strong-Pass-2026-x');
      expect(result.stdout).toContain('沿用 .env.local 中已有值');
      // The other fields are still completed.
      expect((env.get('SESSION_SECRET') ?? '').length).toBeGreaterThanOrEqual(32);
      expect(env.get('ENCRYPTION_KEY')).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);

  it('ignores an inherited NODE_ENV=test so Next keeps reading .env.local (regression)', async () => {
    const dir = makeSandbox();
    const occupied = await occupyPort();
    try {
      // vitest sets NODE_ENV=test on its children. Next's env loader skips .env.local in the
      // test environment, which silently produced "ADMIN_PASSWORD is not set" servers whose
      // every login was rejected. The dev launcher must normalise that away and say so.
      const result = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-Port', String(occupied.port), '-SkipInstall'],
        { cwd: dir, env: { NODE_ENV: 'test', ADMIN_PASSWORD: 'inherited-but-wrong' }, timeoutMs: 120_000 },
      );
      expect(result.exitCode, `stdout:\n${result.stdout}`).toBe(1);
      expect(result.stdout).toContain('已忽略从父进程继承的变量');
      expect(result.stdout).toContain('NODE_ENV=test');
      expect(result.stdout).toContain('ADMIN_PASSWORD');
      // The generated .env.local still wins, exactly once.
      const env = readEnvFile(join(dir, '.env.local'));
      expect((env.get('ADMIN_PASSWORD') ?? '').length).toBeGreaterThanOrEqual(12);
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);

  it('-SkipInstall fails fast on missing dependencies and does not touch .env.local', async () => {
    const dir = makeSandbox({ withNodeModules: false });
    const result = await runPowerShell(
      join(dir, 'scripts', 'start-dev.ps1'),
      ['-SkipInstall'],
      { cwd: dir, timeoutMs: 60_000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('依赖缺失');
    expect(result.stdout).toContain('npm install');
    // The dependency check runs before the env bootstrap, so nothing was generated.
    expect(existsSync(join(dir, '.env.local'))).toBe(false);
    expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
  }, 120_000);

  it('hard-fails with upgrade guidance when Node reports a version below 22.5', async () => {
    const dir = makeSandbox();
    // Simulate an old runtime without installing one: NODE_OPTIONS preloads a module
    // that rewrites process.versions.node before -p is evaluated.
    const shim = join(dir, 'fake-node-version.cjs');
    writeFileSync(
      shim,
      "Object.defineProperty(process.versions, 'node', { value: '18.0.0', configurable: true, enumerable: true });\n",
      'utf8',
    );
    const result = await runPowerShell(
      join(dir, 'scripts', 'start-dev.ps1'),
      ['-SkipInstall'],
      // node's NODE_OPTIONS tokenizer treats `\` as an escape character, so the
      // preload path is passed with forward slashes.
      { cwd: dir, env: { NODE_OPTIONS: `--require "${shim.replace(/\\/g, '/')}"` }, timeoutMs: 120_000 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain('18.0.0');
    expect(result.stdout).toContain('22.5');
    // Actionable guidance, not just a failure code.
    expect(result.stdout).toMatch(/nodejs\.org|winget|nvm/);
    // The run must abort before any server or runtime artefact is produced.
    expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);
    expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
    expect(existsSync(join(dir, '.env.local'))).toBe(false);
  }, 180_000);
});

describe('scripts/stop-dev.ps1 idempotency and safety', () => {
  it('exits 0 with nothing to stop, and again on a repeat run', async () => {
    const dir = makeSandbox();
    for (const attempt of [1, 2]) {
      const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], {
        cwd: dir,
        timeoutMs: 60_000,
      });
      expect(result.exitCode, `attempt ${attempt}: ${result.stdout}`).toBe(0);
      expect(result.stdout).toContain('没有正在运行的开发服务器');
    }
  }, 120_000);

  it('clears a stale .dev-server.pid whose process is already gone, without failing', async () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, '.dev-server.pid'), '999999\n', 'utf8');
    const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);
  }, 120_000);

  it('kills a dev process that still owns the recorded port (fallback path) and frees it', async () => {
    const dir = makeSandbox();
    // A node listener with a stale pid file: only the port fallback can stop it.
    // Its command line carries the sandbox path — that is what an orphaned
    // `node <root>/node_modules/next/dist/bin/next dev` looks like, and it is the
    // evidence stop-dev.ps1 now demands before it kills anything.
    const listener = spawn(
      process.execPath,
      [
        '-e',
        "require('http').createServer(()=>{}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
        dir,
      ],
      { windowsHide: true },
    );
    spawned.push(listener);
    listener.stdout.setEncoding('utf8');
    const port = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('node listener reported no port')), 20_000);
      listener.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const first = buffer.split(/\r?\n/)[0]?.trim();
        if (first && /^\d+$/.test(first)) {
          clearTimeout(timer);
          resolve(Number.parseInt(first, 10));
        }
      });
    });
    writeFileSync(join(dir, '.dev-server.port'), `${port}\n`, 'utf8');
    writeFileSync(join(dir, '.dev-server.pid'), '999999\n', 'utf8');

    expect(await tcpConnectable(port), 'listener never came up').toBe(true);

    const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], {
      cwd: dir,
      timeoutMs: 90_000,
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain('已确认属于本仓库');
    expect(await tcpConnectable(port)).toBe(false);
    expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
    expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);
  }, 180_000);

  it('never kills a foreign node.exe holding the recorded port (regression: another project on the same port)', async () => {
    const dir = makeSandbox();
    // Exactly the reported hazard: another project's `next start -p <port>` is also a
    // node.exe, its name is in the allow list, and its command line never mentions this
    // repository. A stale .dev-server.port from a crashed run must not become a licence
    // to kill it.
    const listener = spawn(
      process.execPath,
      [
        '-e',
        "require('http').createServer(function(q,s){s.writeHead(200);s.end('foreign project')}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
      ],
      { windowsHide: true },
    );
    spawned.push(listener);
    listener.stdout.setEncoding('utf8');
    const port = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('foreign node listener reported no port')), 20_000);
      listener.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const first = buffer.split(/\r?\n/)[0]?.trim();
        if (first && /^\d+$/.test(first)) {
          clearTimeout(timer);
          resolve(Number.parseInt(first, 10));
        }
      });
    });
    writeFileSync(join(dir, '.dev-server.port'), `${port}\n`, 'utf8');

    expect(await tcpConnectable(port), 'foreign listener never came up').toBe(true);

    const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], {
      cwd: dir,
      timeoutMs: 90_000,
    });

    // The foreign process must survive, and the conflict must be reported honestly:
    // a stuck port is not a clean shutdown, so the exit code is non-zero.
    expect(result.stdout).toContain('不属于本仓库');
    expect(result.exitCode).toBe(1);
    expect(await tcpConnectable(port), 'stop-dev.ps1 killed another project\'s node.exe').toBe(true);
    // The runtime artefacts are still cleaned up so the next start is not blocked by them.
    expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
    if (listener.exitCode === null) listener.kill('SIGKILL');
  }, 180_000);

  it('ignores a stale .dev-server.pid that the OS recycled to an unrelated process', async () => {
    const dir = makeSandbox();
    // PID 4 (System) is never a dev process: the recorded PID must not be trusted blindly.
    writeFileSync(join(dir, '.dev-server.pid'), '4\n', 'utf8');
    const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain('不是本仓库的 dev 进程');
    expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);
  }, 120_000);

  it('refuses to kill an unrelated program holding the recorded port, and says so', async () => {
    const dir = makeSandbox();
    const { port } = await startForeignListener();
    writeFileSync(join(dir, '.dev-server.port'), `${port}\n`, 'utf8');
    expect(await tcpConnectable(port)).toBe(true);

    const result = await runPowerShell(join(dir, 'scripts', 'stop-dev.ps1'), [], {
      cwd: dir,
      timeoutMs: 90_000,
    });

    // Safety gate: a non-dev process must survive, and the operator gets a non-zero
    // exit so a stuck port is never reported as a clean shutdown.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('非开发进程');
    expect(await tcpConnectable(port), 'stop-dev.ps1 killed a foreign process').toBe(true);
  }, 180_000);
});

describe('scripts/test-api.ps1 failure semantics', () => {
  it('exits non-zero when an assertion fails and still runs the finally cleanup', async () => {
    // Force the very first assertion to fail by handing the script a port that is
    // already taken by a non-dev process, so start-dev.ps1 refuses to start.
    const { port } = await startForeignListener();
    try {
      const result = await runPowerShell(
        join(projectRoot, 'scripts', 'test-api.ps1'),
        ['-Port', String(port), '-SkipInstall'],
        { cwd: projectRoot, timeoutMs: 600_000 },
      );

      expect(result.timedOut).toBe(false);
      // Acceptance: any failed assertion must surface as a non-zero exit code.
      expect(result.exitCode, result.stdout.slice(-2000)).toBe(1);
      expect(result.stdout).toContain('FAIL');
      expect(result.stdout).toMatch(/RESULT:\s*\d+\/\d+ PASS,\s*[1-9]\d* FAIL/);
      expect(result.stdout).not.toContain('全部断言通过');

      // The finally block must still have attempted the shutdown script.
      expect(result.stdout).toContain('AragonRouter 开发服务器停止器');
      // The foreign listener is not a dev process: it must still be alive.
      expect(await tcpConnectable(port)).toBe(true);
    } finally {
      for (const child of spawned) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
  }, 720_000);
});

describe('scripts/test-api.ps1 mid-run failure semantics (regression: the finally must still stop the service)', () => {
  /**
   * Both cases below fail *after* the dev server is up and already recorded, which is the
   * path no earlier test covered: the old suite only proved that the very first assertion
   * failing (start-dev.ps1 refusing an occupied port) leads to a non-zero exit, and a static
   * grep confirmed the finally block merely *mentions* stop-dev.ps1. Neither showed that a
   * run dying in the middle actually releases the port.
   *
   * Assertions therefore look at the observable end state: exit code, the finally's own
   * verification line, the recorded PID being gone, and .dev-server.pid / .dev-server.port
   * being cleaned up. Port probes are done against the repository's own listeners (not a bare
   * TCP connect), because other suites run in parallel and may legitimately take a freed port.
   */
  const portFile = join(projectRoot, '.dev-server.port');
  const pidFile = join(projectRoot, '.dev-server.pid');

  function clearRuntimeArtifacts(): void {
    for (const path of [portFile, pidFile]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // A leftover handle from an earlier case is harmless; the scripts rewrite the files.
      }
    }
  }

  /** Wait until the scripts have recorded a live server, and return what they recorded. */
  async function waitForRecordedServer(timeoutMs: number): Promise<{ port: number; pid: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const port = Number.parseInt(readFileSync(portFile, 'utf8').trim(), 10);
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isInteger(port) && port > 0 && Number.isInteger(pid) && pid > 0) return { port, pid };
      } catch {
        // .dev-server.port / .dev-server.pid are written once the server is up; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('test-api.ps1 never recorded a running dev server');
  }

  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Listening ports of processes whose command line mentions the repository root. */
  function repoListenerPorts(): Promise<number[]> {
    const command =
      `$root = '${projectRoot.replace(/'/g, "''")}'; ` +
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

  it('stops the server and releases the port when the run is aborted mid-way (-AbortAfterStep)', async () => {
    clearRuntimeArtifacts();

    // Fatal abort after the 10th assertion: the server is up, a key and two providers exist.
    const run = runPowerShell(
      join(projectRoot, 'scripts', 'test-api.ps1'),
      ['-SkipInstall', '-AbortAfterStep', '10'],
      { cwd: projectRoot, timeoutMs: 900_000 },
    );
    const recorded = await waitForRecordedServer(180_000);
    const result = await run;

    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.stdout.slice(-3000)).toBe(1);
    expect(result.stdout).toContain('FATAL 运行被中断');
    // Ordinary assertion printing must not claim success on an aborted run.
    expect(result.stdout).not.toContain('全部断言通过');
    // The finally must not only call stop-dev.ps1 but verify the outcome.
    expect(result.stdout).toContain('收尾停机完成');

    expect(await repoListenerPorts(), 'a dev server is still listening after the aborted run').not.toContain(
      recorded.port,
    );
    expect(processAlive(recorded.pid), `recorded dev PID ${recorded.pid} survived the finally cleanup`).toBe(false);
    expect(existsSync(portFile), '.dev-server.port left behind by the aborted run').toBe(false);
    expect(existsSync(pidFile), '.dev-server.pid left behind by the aborted run').toBe(false);
  }, 900_000);

  it('stops the server and releases the port when the stub upstream dies mid-run', async () => {
    clearRuntimeArtifacts();

    // The stub exits right after the first relayed upstream request (the provider
    // connectivity probe), so the assertions *after* the server is up start failing.
    const run = runPowerShell(join(projectRoot, 'scripts', 'test-api.ps1'), ['-SkipInstall'], {
      cwd: projectRoot,
      timeoutMs: 900_000,
      env: { STUB_EXIT_AFTER_REQUESTS: '1' },
    });
    const recorded = await waitForRecordedServer(180_000);
    const result = await run;

    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.stdout.slice(-3000)).toBe(1);
    expect(result.stdout).toMatch(/RESULT:\s*\d+\/\d+ PASS,\s*[1-9]\d* FAIL/);
    // The mid-run failure must be diagnosed, not reported as a clean run.
    expect(result.stdout).not.toContain('全部断言通过');
    // Mid-run failures still reach the shutdown steps, and the finally re-verifies them.
    expect(result.stdout).toContain('收尾停机完成');

    expect(await repoListenerPorts(), 'a dev server is still listening after the failed run').not.toContain(
      recorded.port,
    );
    expect(processAlive(recorded.pid), `recorded dev PID ${recorded.pid} survived the failed run`).toBe(false);
    expect(existsSync(portFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  }, 900_000);
});

describe('scripts/test-api.ps1 -KeepServer', () => {
  it('really keeps the server: skips the shutdown steps, leaves pid/port behind, and stays logged-in', async () => {
    const portFile = join(projectRoot, '.dev-server.port');
    const pidFile = join(projectRoot, '.dev-server.pid');

    const result = await runPowerShellToFile(
      join(projectRoot, 'scripts', 'test-api.ps1'),
      ['-KeepServer', '-SkipInstall'],
      { cwd: projectRoot, timeoutMs: 600_000 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.stdout.slice(-4000)).toBe(0);
    expect(result.stdout).toMatch(/RESULT:\s*\d+\/\d+ PASS,\s*0 FAIL/);

    // The regression: -KeepServer must skip the stop steps themselves, not only the
    // finally fallback (the old build stopped the server and asserted the port was free).
    expect(result.stdout).toContain('保留现场（-KeepServer）');
    expect(result.stdout).not.toContain('停机（scripts/stop-dev.ps1）后端口释放');
    expect(result.stdout).not.toContain('重复执行 stop-dev.ps1 幂等');
    expect(result.stdout).not.toContain('全部断言通过：转发、流式、鉴权、日志、统计、启停链路均正常');

    // And the scene must really still be there for manual debugging.
    expect(existsSync(portFile), '.dev-server.port was removed despite -KeepServer').toBe(true);
    expect(existsSync(pidFile), '.dev-server.pid was removed despite -KeepServer').toBe(true);
    const port = Number.parseInt(readFileSync(portFile, 'utf8').trim(), 10);
    expect(port).toBeGreaterThan(0);
    expect(readFileSync(pidFile, 'utf8').trim()).toMatch(/^\d+$/);
    expect(await tcpConnectable(port), 'kept server is not reachable').toBe(true);

    try {
      // The operator can keep working against it: the admin endpoint still answers.
      const probe = await new Promise<boolean>((resolve) => {
        const socket = new Socket();
        socket.setTimeout(3000);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => resolve(false));
        socket.connect(port, '127.0.0.1');
      });
      expect(probe).toBe(true);
    } finally {
      const stop = await runPowerShell(join(projectRoot, 'scripts', 'stop-dev.ps1'), ['-Quiet'], {
        cwd: projectRoot,
        timeoutMs: 120_000,
      });
      expect(stop.exitCode, stop.stdout).toBe(0);
    }

    // The kept server was ours, so stop-dev.ps1 must release the port and clean up.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await tcpConnectable(port))) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(await tcpConnectable(port), 'port still open after the final stop').toBe(false);
    expect(existsSync(portFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  }, 900_000);
});

describe('scripts/start-dev.ps1 -Foreground', () => {
  it('records PID, port and dev.log like the background mode, and serves until it is killed (C11)', async () => {
    const freePort = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
      });
    });

    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(projectRoot, 'scripts', 'start-dev.ps1'),
        '-Foreground',
        '-Port',
        String(freePort),
        '-SkipInstall',
      ],
      { cwd: projectRoot, windowsHide: true },
    );
    spawned.push(child);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });

    const portFile = join(projectRoot, '.dev-server.port');
    const pidFile = join(projectRoot, '.dev-server.pid');
    const logFile = join(projectRoot, '.dev-logs', 'dev.log');

    try {
      // C11 applies to the foreground mode too: port file, pid file and dev.log.
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 120_000;
        const timer = setInterval(() => {
          if (
            existsSync(portFile) &&
            readFileSync(portFile, 'utf8').trim() === String(freePort) &&
            existsSync(pidFile) &&
            /^\d+$/.test(readFileSync(pidFile, 'utf8').trim())
          ) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error(`foreground run never recorded pid+port; output: ${output.slice(-1500)}`));
          }
        }, 250);
      });

      expect(output).toContain('前台模式运行');

      // The server must actually answer on that port while the script runs, and the script
      // must announce the URL the operator should open.
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (await tcpConnectable(freePort)) {
          ready = true;
          break;
        }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(ready, `foreground server never answered on ${freePort}; output: ${output.slice(-1500)}`).toBe(true);

      // Wait for the readiness banner (printed after the HTTP probe succeeds).
      await new Promise<void>((resolve, reject) => {
        const bannerDeadline = Date.now() + 120_000;
        const timer = setInterval(() => {
          if (output.includes(`http://127.0.0.1:${freePort}`) && output.includes('开发服务器已就绪（前台模式）')) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() > bannerDeadline) {
            clearInterval(timer);
            reject(new Error(`no readiness banner; output: ${output.slice(-1500)}`));
          }
        }, 250);
      });

      // dev output goes to .dev-logs/dev.log even in foreground mode (and is echoed live).
      await new Promise<void>((resolve, reject) => {
        const logDeadline = Date.now() + 60_000;
        const timer = setInterval(() => {
          if (existsSync(logFile) && readFileSync(logFile, 'utf8').trim().length > 0) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() > logDeadline) {
            clearInterval(timer);
            reject(new Error(`.dev-logs/dev.log stayed empty; output: ${output.slice(-800)}`));
          }
        }, 250);
      });
      expect(readFileSync(logFile, 'utf8').length).toBeGreaterThan(0);
    } finally {
      if (child.exitCode === null) {
        // Kill the whole tree (powershell -> npm.cmd -> node), then make sure the
        // port really is released so the suite leaves nothing behind.
        spawn('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (await tcpConnectable(freePort))) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      const stop = await runPowerShell(join(projectRoot, 'scripts', 'stop-dev.ps1'), ['-Quiet'], {
        cwd: projectRoot,
        timeoutMs: 120_000,
      });
      expect(stop.exitCode, stop.stdout).toBe(0);
      expect(existsSync(portFile)).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
    }
  }, 720_000);
});

describe('scripts/start-dev.ps1 port selection', () => {
  it('rejects an explicitly requested port that is already in use', async () => {
    const dir = makeSandbox();
    const occupied = await occupyPort();
    try {
      const result = await runPowerShell(
        join(dir, 'scripts', 'start-dev.ps1'),
        ['-Port', String(occupied.port), '-SkipInstall'],
        { cwd: dir, timeoutMs: 120_000 },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`端口 ${occupied.port} 已被占用`);
      // Nothing may be recorded when startup never happened.
      expect(existsSync(join(dir, '.dev-server.port'))).toBe(false);
      expect(existsSync(join(dir, '.dev-server.pid'))).toBe(false);
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);

  it('never leaves a half-written port file behind after a failed start', async () => {
    const dir = makeSandbox();
    const occupied = await occupyPort();
    try {
      await runPowerShell(join(dir, 'scripts', 'start-dev.ps1'), ['-Port', String(occupied.port), '-SkipInstall'], {
        cwd: dir,
        timeoutMs: 120_000,
      });
      const leftovers = readdirSync(dir).filter((entry) => entry.startsWith('.dev-server'));
      expect(leftovers).toEqual([]);
    } finally {
      await closeServer(occupied.server);
    }
  }, 180_000);
});
