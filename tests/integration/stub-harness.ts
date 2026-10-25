import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Shared harness for the integration suites: boot the repository stub upstream the
 * exact way `scripts/test-api.ps1` boots it (same file, same stdout contract) and
 * talk to it over real loopback sockets.
 */

export const STUB_SCRIPT_PATH = fileURLToPath(new URL('./stub-upstream.mjs', import.meta.url));

/** Credentials the stub treats as "provider credentials" (never `ar-...`). */
export const STUB_ANTHROPIC_KEY = 'stub-anthropic-upstream-credential';
export const STUB_OPENAI_KEY = 'stub-openai-upstream-credential';

export interface StubRecord {
  method: string;
  path: string;
  at: string;
  authKind: string;
  apiKeyValue: string;
  authorizationValue: string;
  credentialLeak: boolean;
  anthropicVersion: string;
  accept: string;
  contentType: string;
  stream: boolean;
  model: string | null;
}

export interface StubState {
  count: number;
  requests: StubRecord[];
}

export interface StubHandle {
  port: number;
  baseUrl: string;
  child: ChildProcess;
  /** Raw stdout lines: the contract with `scripts/test-api.ps1` is "first line is the port". */
  stdoutLines: string[];
  stderr: () => string;
  stop: () => Promise<void>;
}

/**
 * Start `tests/integration/stub-upstream.mjs` and resolve once it reports its port.
 * Mirrors the script: the port is the first stdout line and must be a bare integer.
 */
export async function startStubUpstream(timeoutMs = 20_000): Promise<StubHandle> {
  const child = spawn(process.execPath, [STUB_SCRIPT_PATH], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STUB_CHUNK_DELAY_MS: '2' },
  });

  const stdoutLines: string[] = [];
  let stderrText = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length > 0) stdoutLines.push(line);
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  const port = await new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const first = stdoutLines.find((line) => line.trim().length > 0);
      if (first !== undefined) {
        const parsed = Number.parseInt(first.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) {
          clearInterval(timer);
          resolve(parsed);
        }
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`stub upstream exited with code ${child.exitCode}: ${stderrText}`));
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`stub upstream did not report a port within ${timeoutMs} ms: ${stderrText}`));
      }
    }, 25);
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    stdoutLines,
    stderr: () => stderrText,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/** `GET /__stub/state` — the observation channel `test-api.ps1` asserts against. */
export async function readStubState(baseUrl: string): Promise<StubState> {
  const response = await fetch(`${baseUrl}/__stub/state`);
  if (response.status !== 200) {
    throw new Error(`expected 200 from /__stub/state, got ${response.status}`);
  }
  return (await response.json()) as StubState;
}

/** `POST /__stub/reset` — clear the recorded requests between test cases. */
export async function resetStubState(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/__stub/reset`, { method: 'POST' });
  if (response.status !== 200) {
    throw new Error(`expected 200 from /__stub/reset, got ${response.status}`);
  }
}

/** Poll `check` until it returns a value or the deadline passes (async log writes). */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    last = result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms${options.label ? `: ${options.label}` : ''} (last: ${String(last)})`);
}
