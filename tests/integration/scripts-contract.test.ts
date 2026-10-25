import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODELS_PATH, RELAY_PATHS } from '@/lib/upstream';

/**
 * Contract/regression tests for the `ops-scripts` deliverables: the three PowerShell
 * entry points, their shared helper library, the offline stub upstream, `.gitignore`,
 * `.env.example` and the Chinese README.
 *
 * The end-to-end behaviour of the scripts is exercised for real by
 * `scripts/test-api.ps1` and `tests/integration/scripts-harness.ps1`; what this file
 * adds is the acceptance criteria that are *static properties* of the artefacts
 * (no hardcoded port, required parameters, required README sections, required
 * gitignore entries) plus the cross-work-package wiring checks: each path, model id
 * and header name a script depends on is compared against the gateway source and the
 * stub, so renaming one side cannot silently break the other.
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (relativePath: string): string => readFileSync(`${projectRoot}${relativePath}`, 'utf8');
const fileExists = (relativePath: string): boolean => existsSync(`${projectRoot}${relativePath}`);

const PATHS = {
  common: 'scripts/lib/dev-common.ps1',
  start: 'scripts/start-dev.ps1',
  stop: 'scripts/stop-dev.ps1',
  testApi: 'scripts/test-api.ps1',
  stub: 'tests/integration/stub-upstream.mjs',
  readme: 'README.md',
  gitignore: '.gitignore',
  envExample: '.env.example',
  packageJson: 'package.json',
} as const;

const scripts = {
  common: read(PATHS.common),
  start: read(PATHS.start),
  stop: read(PATHS.stop),
  testApi: read(PATHS.testApi),
  stub: read(PATHS.stub),
  readme: read(PATHS.readme),
  gitignore: read(PATHS.gitignore),
  envExample: read(PATHS.envExample),
};

/** Lines of a PowerShell script that would pin the dev server to one port. */
const HARDCODED_PORT = /(:\s*3000\b)|(-p\s+3000\b)|(-Port\s+3000\b)|(-H\s+127\.0\.0\.1\s+-p\s+3000)/;

describe('scripts/: deliverables exist where the README says they are', () => {
  it.each([
    PATHS.common,
    PATHS.start,
    PATHS.stop,
    PATHS.testApi,
    PATHS.stub,
    PATHS.readme,
    PATHS.gitignore,
    PATHS.envExample,
  ])('%s exists and is not empty', (relativePath) => {
    expect(fileExists(relativePath)).toBe(true);
    expect(read(relativePath).length).toBeGreaterThan(200);
  });

  it('every PowerShell script carries the 5.1 requirement and stops on error', () => {
    for (const script of [scripts.start, scripts.stop, scripts.testApi]) {
      expect(script).toContain('#Requires -Version 5.1');
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      // Shared helpers are dot-sourced, never duplicated.
      expect(script).toContain('dev-common.ps1');
    }
  });
});

describe('scripts/start-dev.ps1 (one-key start)', () => {
  it('declares -Port, -SkipInstall and -Foreground', () => {
    expect(scripts.start).toMatch(/\[int\]\$Port = 0/);
    expect(scripts.start).toMatch(/\[switch\]\$SkipInstall/);
    expect(scripts.start).toMatch(/\[switch\]\$Foreground/);
  });

  it('hard-fails on Node < 22.5 with actionable upgrade guidance', () => {
    expect(scripts.start).toMatch(/\[version\]'22\.5\.0'/);
    expect(scripts.start).toMatch(/\$nodeVersion -lt \$MinimumNodeVersion/);
    // The message must tell the operator how to fix it, not just that it failed.
    expect(scripts.start).toContain('nodejs.org');
    expect(scripts.start).toContain('winget');
    expect(scripts.start).toContain('nvm');
    expect(scripts.start).toContain('node:sqlite');
  });

  it('waits at most 120 s for readiness by default and polls over HTTP', () => {
    expect(scripts.start).toMatch(/\[int\]\$TimeoutSeconds = 120/);
    expect(scripts.start).toContain('Test-HttpReady');
    expect(scripts.start).toMatch(/\$deadline = \(Get-Date\)\.AddSeconds\(\$TimeoutSeconds\)/);
  });

  it('prints URL, PID and the log path after readiness', () => {
    const tail = scripts.start.slice(scripts.start.indexOf("Write-Ok '开发服务器已就绪。'"));
    expect(tail).toContain('URL');
    expect(tail).toContain('PID');
    expect(tail).toContain('日志');
    expect(tail).toContain('$artifacts.LogFile');
  });

  it('records the real port in .dev-server.port and the PID in .dev-server.pid', () => {
    expect(scripts.start).toMatch(/Set-TextFile -Path \$artifacts\.PidFile/);
    expect(scripts.start).toMatch(/Set-TextFile -Path \$artifacts\.PortFile -Value \(\[string\]\$targetPort\)/);
  });

  it('creates .env.local on first run and prints the generated password', () => {
    expect(scripts.start).toContain('function Initialize-EnvLocal');
    for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
      expect(scripts.start).toContain(key);
    }
    expect(scripts.start).toContain('Set-EnvValues');
    expect(scripts.start).toContain('管理口令 ADMIN_PASSWORD');
  });

  it('installs missing dependencies unless -SkipInstall was passed', () => {
    expect(scripts.start).toContain('function Assert-Dependencies');
    expect(scripts.start).toMatch(/install --no-audit --no-fund/);
    expect(scripts.start).toMatch(/if \(\$SkipInstallFlag\)/);
  });

  it('picks a free port by scanning upward instead of pinning one', () => {
    expect(scripts.start).toContain('Find-FreePort');
    expect(scripts.common).toMatch(/function Find-FreePort/);
    expect(scripts.common).toMatch(/\[int\]\$StartPort = 3000/);
    expect(scripts.common).toMatch(/\$candidate\+\+/);
    expect(scripts.start).toMatch(/Find-FreePort -StartPort 3000 -Attempts \d+/);
  });

  it('reuses an already-running instance instead of starting a second one', () => {
    expect(scripts.start).toContain('function Get-RunningDevServer');
    expect(scripts.start).toContain('开发服务器已在运行');
  });

  it('exits non-zero when startup fails', () => {
    expect(scripts.start).toMatch(/\$exitCode = 1/);
    expect(scripts.start).toMatch(/exit \$exitCode/);
  });
});

describe('scripts/stop-dev.ps1 (one-key stop)', () => {
  it('kills the recorded process tree with taskkill /T /F and waits for it', () => {
    expect(scripts.stop).toContain('Stop-ProcessTree');
    expect(scripts.stop).toContain('Wait-ProcessGone');
    expect(scripts.common).toMatch(/taskkill/);
    expect(scripts.common).toMatch(/'\/T',\s*'\/F'/);
  });

  it('has a port-based fallback that only touches dev processes', () => {
    expect(scripts.stop).toContain('Get-PortOwnerPids');
    expect(scripts.stop).toContain('Wait-PortFree');
    expect(scripts.stop).toMatch(/\$AllowedProcessNames = @\('node', 'cmd'/);
  });

  it('cleans up the runtime artefacts', () => {
    expect(scripts.stop).toMatch(/\$artifacts\.PidFile, \$artifacts\.PortFile/);
    expect(scripts.stop).toContain('Remove-Item');
  });

  it('is idempotent: no devices running means exit 0', () => {
    expect(scripts.stop).toMatch(/\$exitCode = 0/);
    expect(scripts.stop).toContain('没有正在运行的开发服务器');
    // A failure may only come from a real problem (port stuck / cleanup failed).
    expect(scripts.stop).toMatch(/if \(\$failures\.Count -gt 0\)/);
  });
});

describe('scripts/test-api.ps1 (offline end-to-end verification)', () => {
  const chain = [
    '401',
    'authentication_error',
    'aragon_session',
    'HttpOnly',
    'SameSite=Lax',
    'unauthorized',
    'text/event-stream',
    'event: message_start',
    'event: message_stop',
    'chat.completion',
    'totals.requests',
    '/api/admin/logs',
    '/api/admin/stats',
    '/api/admin/providers',
    '/api/admin/keys',
  ];

  it.each(chain)('asserts %s', (token) => {
    expect(scripts.testApi).toContain(token);
  });

  it('covers the full acceptance chain in order', () => {
    // Only the main flow (below the comment header) counts; the header repeats the
    // chain in prose and would make an indexOf-based ordering check meaningless.
    const body = scripts.testApi.slice(scripts.testApi.indexOf('# 主流程'));
    expect(body.length).toBeGreaterThan(1000);

    const sequence = [
      '启动开发服务器（scripts/start-dev.ps1）',
      '管理员登录',
      '创建 API Key',
      '创建 Provider（anthropic + openai',
      '非流式转发',
      'SSE 流式转发',
      'OpenAI 兼容转发',
      '模型列表',
      '无效 API Key 返回 401',
      '请求日志',
      '用量统计',
      '停机（scripts/stop-dev.ps1）后端口释放',
      '重复执行 stop-dev.ps1 幂等',
    ];
    let cursor = -1;
    for (const marker of sequence) {
      const index = body.indexOf(marker);
      expect(index, `missing step: ${marker}`).toBeGreaterThan(-1);
      expect(index, `step out of order: ${marker}`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('reads the port from .dev-server.port instead of assuming one', () => {
    expect(scripts.testApi).toContain('Read-DevPort');
    expect(scripts.testApi).toContain(".dev-server.port");
    expect(scripts.testApi).toMatch(/\$state\.BaseUrl = "http:\/\/127\.0\.0\.1:\$\(\$state\.Port\)"/);
  });

  it('always stops the server in a finally block and asserts the port is released', () => {
    const finallyIndex = scripts.testApi.indexOf('finally {');
    expect(finallyIndex).toBeGreaterThan(0);
    const finallyBlock = scripts.testApi.slice(finallyIndex);
    expect(finallyBlock).toContain('$artifacts.StopScript');
    expect(scripts.testApi).toContain('Test-PortInUse');
    expect(scripts.testApi).toContain('Test-TcpConnect');
    expect(scripts.testApi).toMatch(/not \(Test-Path -LiteralPath \$artifacts\.PidFile\)/);
    expect(scripts.testApi).toMatch(/not \(Test-Path -LiteralPath \$artifacts\.PortFile\)/);
  });

  it('exits non-zero when any assertion fails', () => {
    // The guard also covers a fatal abort and a finally shutdown that failed to release the
    // port, so it is no longer exactly `if ($script:Failed -gt 0)`.
    expect(scripts.testApi).toMatch(/if \(\$script:Failed -gt 0[^\n]*\) \{/);
    expect(scripts.testApi).toMatch(/\$script:FinallyStopFailed/);
    expect(scripts.testApi).toMatch(/\$script:FatalMessage/);
    expect(scripts.testApi).toMatch(/exit 1/);
    expect(scripts.testApi).toMatch(/Write-Host \("FAIL  "/);
    expect(scripts.testApi).toMatch(/Write-Host \("PASS  "/);
  });

  it('prints step results as PASS/FAIL lines an operator can scan', () => {
    expect(scripts.testApi).toContain('RESULT:');
    expect(scripts.testApi).toMatch(/\{0\}\/\{1\} PASS/);
  });

  it('never echoes a secret to the console', () => {
    // The plaintext key must not be printed; only its prefix is allowed.
    expect(scripts.testApi).not.toMatch(/Write-Host[^\n]*\$state\.ApiKey\b/);
    expect(scripts.testApi).toContain('Assert-NotContains $response.Content $state.ApiKey');
    expect(scripts.testApi).toContain('Assert-NotContains ([string]$json.data.maskedKey) $UpstreamAnthropicKey');
  });
});

describe('no script hardcodes the dev port', () => {
  it.each([
    ['scripts/start-dev.ps1', scripts.start],
    ['scripts/stop-dev.ps1', scripts.stop],
    ['scripts/test-api.ps1', scripts.testApi],
    ['scripts/lib/dev-common.ps1', scripts.common],
  ])('%s never pins 3000 as the server port', (_name, source) => {
    const offending = source
      .split(/\r?\n/)
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => HARDCODED_PORT.test(entry.line));
    expect(offending, `hardcoded port: ${JSON.stringify(offending)}`).toEqual([]);
  });
});

describe('scripts/lib/dev-common.ps1 (C11 runtime artefacts)', () => {
  it('exposes exactly the artefact paths the contract names', () => {
    expect(scripts.common).toMatch(/PidFile\s*=\s*Join-Path \$ProjectRoot '\.dev-server\.pid'/);
    expect(scripts.common).toMatch(/PortFile\s*=\s*Join-Path \$ProjectRoot '\.dev-server\.port'/);
    expect(scripts.common).toMatch(/\$logDir = Join-Path \$ProjectRoot '\.dev-logs'/);
    expect(scripts.common).toMatch(/LogFile\s*=\s*Join-Path \$logDir 'dev\.log'/);
  });

  it('generates cryptography-grade secrets for .env.local', () => {
    expect(scripts.common).toContain('RandomNumberGenerator');
    expect(scripts.common).toContain('function New-RandomHex');
    expect(scripts.common).toContain('function New-RandomBase64Url');
  });

  it('writes files without a BOM so dotenv parses the first key', () => {
    expect(scripts.common).toMatch(/New-Object -TypeName System\.Text\.UTF8Encoding -ArgumentList \$false/);
  });

  it('reads files that the dev server still holds open', () => {
    expect(scripts.common).toContain('[System.IO.FileShare]::ReadWrite');
  });
});

describe('tests/integration/stub-upstream.mjs (offline upstream)', () => {
  it('is dependency-free and offline: only node: builtins are imported', () => {
    const imports = [...scripts.stub.matchAll(/^import\s+.*from\s+'([^']+)';$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, `unexpected external dependency: ${specifier}`).toMatch(/^node:/);
    }
    expect(scripts.stub).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
  });

  it('binds loopback only and reports its port as a single stdout line', () => {
    expect(scripts.stub).toContain("server.listen(0, '127.0.0.1'");
    expect(scripts.stub).toContain('process.stdout.write(`${port}\\n`)');
  });

  it('serves the same paths the gateway relays to (C9)', () => {
    // Cross-module: RELAY_PATHS/MODELS_PATH come from the gateway source.
    expect(scripts.stub).toContain(`const MESSAGES_PATH = '${RELAY_PATHS.anthropic}'`);
    expect(scripts.stub).toContain(`const CHAT_COMPLETIONS_PATH = '${RELAY_PATHS.openai}'`);
    expect(scripts.stub).toContain(`const MODELS_PATH = '${MODELS_PATH}'`);
  });

  it('detects a leaked client key instead of accepting it', () => {
    expect(scripts.stub).toContain("presented.startsWith('ar-')");
    expect(scripts.stub).toContain('credentialLeak');
    expect(scripts.stub).toContain('SECURITY');
  });

  it('exposes the state/reset observation endpoints the script asserts on', () => {
    for (const endpoint of ['/__stub/state', '/__stub/reset']) {
      expect(scripts.stub).toContain(endpoint);
    }
    // test-api.ps1 only reads state; reset exists for manual/debug use.
    expect(scripts.testApi).toContain('/__stub/state');
    expect(scripts.testApi).toContain('credentialLeak');
  });

  it('uses the same model ids as the verification script', () => {
    for (const model of ['stub-anthropic-model', 'stub-openai-model']) {
      expect(scripts.stub).toContain(model);
      expect(scripts.testApi).toContain(model);
    }
  });

  it('uses provider credentials that cannot be confused with a client key', () => {
    // The stub accepts any credential that is not `ar-...`; the concrete values live
    // in test-api.ps1, which asserts they are what the upstream actually received.
    for (const key of ['stub-anthropic-upstream-credential', 'stub-openai-upstream-credential']) {
      expect(scripts.testApi).toContain(key);
      // A provider credential must never look like the gateway's own key shape.
      expect(key.startsWith('ar-')).toBe(false);
    }
  });
});

describe('.gitignore covers every runtime artefact', () => {
  it.each(['.dev-server.pid', '.dev-server.port', '.dev-logs/', 'data/', '.env.local'])(
    'ignores %s',
    (pattern) => {
      const lines = scripts.gitignore.split(/\r?\n/).map((line) => line.trim());
      expect(lines).toContain(pattern);
    },
  );
});

describe('.env.example matches contract C1', () => {
  it('declares the four required variables with the documented shapes', () => {
    const envKeys = [...scripts.envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    expect(envKeys).toEqual(
      expect.arrayContaining(['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']),
    );

    const values = new Map(
      [...scripts.envExample.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => [match[1], match[2]]),
    );
    expect(values.get('DATABASE_PATH')).toBe('./data/aragon.db');
    // The sample key must at least be shaped like a real one (64 hex = 32 bytes).
    expect(values.get('ENCRYPTION_KEY')).toMatch(/^[0-9a-fA-F]{64}$/);
    // The requirements are documented in the comment block above each key.
    expect(scripts.envExample).toContain('at least 32 characters');
    expect(scripts.envExample).toContain('exactly 64 hex characters');
  });

  it('start-dev.ps1 generates exactly the same field names', () => {
    const values = new Map(
      [...scripts.envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => [match[1], match[1]]),
    );
    for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
      expect(values.has(key)).toBe(true);
      expect(scripts.start).toContain(`'${key}'`);
    }
  });
});

describe('README.md is the Chinese operator manual the spec asks for', () => {
  it('is predominantly Chinese prose', () => {
    const cjk = (scripts.readme.match(/[\u4e00-\u9fff]/g) ?? []).length;
    expect(cjk).toBeGreaterThan(1500);
  });

  it.each(['架构', '目录结构', '环境变量', '一键启停', '故障排查', 'curl'])(
    'documents %s',
    (section) => {
      expect(scripts.readme).toContain(section);
    },
  );

  it('documents every command and runtime artefact the scripts produce', () => {
    // Windows docs use backslashes in commands; accept either separator.
    const readme = scripts.readme.replace(/scripts\\/g, 'scripts/');
    for (const token of [
      'scripts/start-dev.ps1',
      'scripts/stop-dev.ps1',
      'scripts/test-api.ps1',
      '.dev-server.pid',
      '.dev-server.port',
      '.dev-logs/dev.log',
      '.env.local',
      '22.5',
    ]) {
      expect(readme, `README does not mention ${token}`).toContain(token);
    }
  });

  it('documents all four environment variables and all customer/admin endpoints', () => {
    const readme = scripts.readme.replace(/\s+/g, ' ');
    for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
      expect(readme).toContain(key);
    }
    for (const path of [
      '/api/v1/messages',
      '/api/v1/chat/completions',
      '/api/v1/models',
      '/api/admin/session',
      '/api/admin/keys',
      '/api/admin/providers',
      '/api/admin/logs',
      '/api/admin/stats',
    ]) {
      expect(readme, `README has no example for ${path}`).toContain(path);
    }
  });

  it('documents the C2 authentication error body and the offline stub upstream', () => {
    const readme = scripts.readme.replace(/\s+/g, '');
    expect(readme).toContain('"type":"error"');
    expect(readme).toContain('authentication_error');
    expect(readme).toContain('桩上游');
    expect(readme).toContain('离线');
    expect(readme).toContain('stub-upstream.mjs');
  });

  it('documents the troubleshooting entries the scripts can actually emit', () => {
    for (const message of [
      'Node.js 版本过低',
      'node:sqlite',
      '-SkipInstall',
      'ENCRYPTION_KEY must be exactly 64 hex characters',
      'invalid password',
    ]) {
      expect(scripts.readme).toContain(message);
    }
  });
});

describe('script suite is wired into the documented npm/tooling surface', () => {
  it('the package scripts still match what the README tells the operator to run', () => {
    const pkg = JSON.parse(read(PATHS.packageJson)) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toBe('next dev');
    expect(pkg.scripts.test).toBe('vitest run');
    expect(scripts.readme).toContain('npm test');
    expect(scripts.readme).toContain('npm run typecheck');
  });

  it('leaves the gateway sources and package.json untouched by the scripts', () => {
    for (const source of [scripts.start, scripts.stop, scripts.testApi, scripts.common]) {
      // No script may write into the application source tree.
      expect(source).not.toMatch(/Set-Content[^\n]*src[\\/]/);
      expect(source).not.toMatch(/Out-File[^\n]*src[\\/]/);
      expect(source).not.toMatch(/npm install[^\n]*--save/);
    }
  });
});

/**
 * Regressions for the four defects found in review 1. Each of these is a property of the
 * shipped scripts, so a future edit that re-introduces the defect fails here even before
 * the (expensive) runtime suites get a chance to run.
 */
describe('stop-dev.ps1 port fallback requires proof of ownership (regression 1)', () => {
  it('consults a process-ownership verdict before touching the port owner', () => {
    expect(scripts.common).toContain('function Get-ProcessOwnership');
    expect(scripts.common).toContain('function Get-ProcessSnapshot');
    expect(scripts.common).toContain('function Test-ProcessServesPort');
    expect(scripts.stop).toContain('Get-OwnershipVerdict');
    expect(scripts.stop).toContain('$ownership = Get-OwnershipVerdict -ProcessId $owner');

    // The gate must come *before* the kill at the port-fallback call site.
    const gateIndex = scripts.stop.indexOf('$ownership = Get-OwnershipVerdict -ProcessId $owner');
    const killIndex = scripts.stop.indexOf('Stop-DevProcess -ProcessId $owner');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(gateIndex);
    expect(scripts.stop).toMatch(/if \(-not \$ownership\.Owned\)/);
  });

  it('requires path evidence rather than trusting the process name alone', () => {
    // A node.exe from another project is indistinguishable by name, so the evidence has to
    // come from the command line / parent chain.
    expect(scripts.stop).toContain('不属于本仓库');
    expect(scripts.stop).toContain('归属证据');
    expect(scripts.common).toContain('Test-PathKeyInsideText');
    expect(scripts.common).toMatch(/ParentProcessId/);
    // A stale pid file must not be trusted blindly either.
    expect(scripts.stop).toContain('PID 已被系统回收复用');
  });

  it('does not report a refused kill as a successful shutdown', () => {
    const gateIndex = scripts.stop.indexOf('if (-not $ownership.Owned)');
    const failureIndex = scripts.stop.indexOf('$failures += "端口 $targetPort 被不属于本仓库的进程', gateIndex);
    expect(failureIndex).toBeGreaterThan(gateIndex);
    expect(scripts.stop).toMatch(/if \(\$failures\.Count -gt 0\)/);
  });
});

describe('test-api.ps1 -KeepServer skips the shutdown steps (regression 2)', () => {
  const body = scripts.testApi.slice(scripts.testApi.indexOf('# 主流程'));

  it('gates the stop steps behind -KeepServer instead of only skipping the finally fallback', () => {
    const keepIndex = body.indexOf('if ($KeepServer)');
    const stopIndex = body.indexOf('停机（scripts/stop-dev.ps1）后端口释放');
    expect(keepIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(keepIndex);
    // The shutdown steps must live in the else branch of the -KeepServer gate.
    expect(body.slice(keepIndex, stopIndex)).toContain('else {');
    // ... and the gate itself must assert the scene is really kept.
    expect(body).toContain('保留现场（-KeepServer）');
  });

  it('documents the parameter as "keep the server", not "skip one cleanup call"', () => {
    expect(scripts.testApi).toContain('**保留开发服务器**');
    expect(scripts.testApi).toContain('finally 兜底停机同样不会执行');
  });
});

describe('start-dev.ps1 never lets a stale environment override .env.local', () => {
  it('normalises an inherited NODE_ENV and inherited gateway secrets', () => {
    expect(scripts.start).toContain('function Reset-DevEnvironment');
    expect(scripts.start).toContain('已忽略从父进程继承的变量');
    expect(scripts.start).toMatch(/GetEnvironmentVariable\('NODE_ENV', 'Process'\)/);
    // Next skips .env.local in the test environment, so the launcher must clear it.
    expect(scripts.start).toContain('跳过 .env.local');
    for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
      expect(scripts.start).toContain(`'${name}'`);
    }
  });

  it('warns when a reused instance rejects the current password', () => {
    const reuse = scripts.start.slice(scripts.start.indexOf('开发服务器已在运行，无需重复启动'));
    expect(reuse).toContain('这个实例不接受当前 .env.local 里的 ADMIN_PASSWORD');
    expect(reuse).toContain('自检');
  });
});

describe('start-dev.ps1 -Foreground honours C11 (regression 3)', () => {
  const foregroundStart = scripts.start.indexOf('if ($Foreground)');
  const foregroundEnd = scripts.start.indexOf('exit $foregroundExit');
  const foreground = scripts.start.slice(foregroundStart, foregroundEnd);

  it('writes .dev-server.pid and .dev-server.port and redirects dev output to .dev-logs/dev.log', () => {
    expect(foregroundStart).toBeGreaterThan(-1);
    expect(foregroundEnd).toBeGreaterThan(foregroundStart);
    expect(foreground).toContain('Set-TextFile -Path $artifacts.PidFile');
    expect(foreground).toContain('Set-TextFile -Path $artifacts.PortFile');
    expect(foreground).toContain('RedirectStandardOutput = $artifacts.LogFile');
    expect(foreground).toContain('RedirectStandardError  = $artifacts.ErrLogFile');
    // The operator still gets the URL and the live log.
    expect(foreground).toContain('开发服务器已就绪（前台模式）');
    expect(foreground).toContain('Write-NewLogLines');
  });

  it('no longer claims the pid file is skipped in foreground mode', () => {
    expect(scripts.start).not.toContain('不写 .dev-server.pid');
    expect(scripts.start).toContain('.dev-logs/dev.log（C11 的三个运行期产物在前后台模式下都成立）');
  });
});

describe('ADMIN_PASSWORD is judged by strength, not by a denylist (regression 4)', () => {
  it('has a structural verdict function instead of a placeholder-name comparison', () => {
    expect(scripts.start).toContain('function Get-AdminPasswordVerdict');
    expect(scripts.start).toContain('PublicPlaceholders');
    expect(scripts.start).toContain('低于脚本要求的');
    // Structural hazards (quote/hash/control chars) are what actually break login.
    expect(scripts.start).toContain('含有 " #');
    expect(scripts.start).toMatch(/\[\\x00-\\x1f\]/);
    // The old name-list-only check must be gone.
    expect(scripts.start).not.toContain('$passwordUsable = ($password.Length -ge 8)');
  });

  it('reports why a password was rotated and verifies the value round-trips', () => {
    expect(scripts.start).toContain('PasswordWasReplaced');
    expect(scripts.start).toContain('PasswordReplaceReason');
    expect(scripts.start).toContain('原口令不可用，原因');
    expect(scripts.start).toContain('写入后回读不一致');
    // and test-api.ps1 must turn a rejected password into actionable guidance
    expect(scripts.testApi).toContain('口令不被网关接受');
    expect(scripts.testApi).toContain('删除 .env.local 后重新运行');
  });
});

/**
 * Regressions for the two defects found in review 2. Both are checked statically here so a
 * future edit that re-introduces them fails immediately, before the (slow) runtime suites
 * that actually boot servers get a chance to run.
 */
describe('start-dev.ps1 / stop-dev.ps1 serialise on a named mutex (regression 5)', () => {
  it('shares one project-scoped mutex instead of racing on the records', () => {
    expect(scripts.common).toContain('function Get-DevLockName');
    expect(scripts.common).toContain('function Enter-DevLock');
    expect(scripts.common).toContain('function Exit-DevLock');
    // A real kernel mutex, not a "check then hope" flag file.
    expect(scripts.common).toContain('System.Threading.Mutex');
    expect(scripts.common).toContain('WaitOne');
    expect(scripts.common).toContain('AbandonedMutexException');
    // The name is derived from the project root, so two terminals on the same copy serialise
    // while two copies of the repository do not clash.
    expect(scripts.common).toContain('AragonRouter-dev-lock-');

    // Both entry points take the same lock and release it before exiting (not in a
    // try/finally: PowerShell would reset the exit code to 0).
    for (const script of [scripts.start, scripts.stop]) {
      expect(script).toContain('Enter-DevLock -ProjectRoot $ProjectRoot');
      expect(script).toContain('Exit-DevLock -Lock $devLock');
    }
    // A caller that cannot get the lock must abandon the run, not start a second server.
    expect(scripts.start).toContain('等待启动互斥量超时');
    expect(scripts.start).toMatch(/if \(-not \$devLock\.Acquired\) \{/);
    expect(scripts.stop).toMatch(/if \(-not \$devLock\.Acquired\) \{/);
  });

  it('takes the lock before touching dependencies or .env.local', () => {
    // Two concurrent runs generating .env.local would leave the loser's server with an
    // ADMIN_PASSWORD the file no longer contains, so the critical section covers that too.
    const lockIndex = scripts.start.indexOf('$devLock = Enter-DevLock');
    expect(lockIndex).toBeGreaterThan(-1);
    expect(scripts.start.indexOf('Initialize-EnvLocal -Artifacts')).toBeGreaterThan(lockIndex);
    expect(scripts.start.indexOf('Assert-Dependencies -Artifacts')).toBeGreaterThan(lockIndex);
    expect(scripts.start.indexOf('Get-RunningDevServer -Artifacts')).toBeGreaterThan(lockIndex);
  });

  it('re-verifies the port owner before trusting what it recorded', () => {
    expect(scripts.start).toContain('function Confirm-PortOwnership');
    expect(scripts.start).toContain('function Write-OrphanWarning');
    const ownershipChecks = scripts.start.match(/Confirm-PortOwnership -Port \$targetPort/g) ?? [];
    // Background mode verifies before declaring success; foreground mode after readiness.
    expect(ownershipChecks.length).toBeGreaterThanOrEqual(2);
    expect(scripts.start).toContain('Test-ProcessServesPort -Snapshot $snapshot -ProcessId $ProcessId -Port $Port');
    // The reuse path must not trust a record whose port is served by another process.
    expect(scripts.start).toContain('不在记录 PID');
  });
});

describe('stop-dev.ps1 scans for unrecorded repo-owned listeners (regression 6)', () => {
  it('has a port-range fallback that still demands proof of ownership', () => {
    expect(scripts.common).toContain('function Find-DevListenersInRange');
    expect(scripts.common).toContain('function Get-ListeningSocketMap');
    expect(scripts.stop).toContain('Find-DevListenersInRange -ProjectRoot $ProjectRoot');
    // Only listeners with ownership evidence may be ended; foreign ones are reported only.
    expect(scripts.stop).toMatch(/\$ownedCandidates = @\(\$scanCandidates \| Where-Object \{ \$_.Owned -and \$_.NameAllowed \}\)/);
    expect(scripts.stop).toContain('未记录的 dev 进程');
    // The scan is skippable and its window is configurable (3000 is only a starting point).
    expect(scripts.stop).toContain('[switch]$NoPortScan');
    expect(scripts.stop).toMatch(/\[int\]\$ScanStartPort = 3000/);
    expect(scripts.stop).toMatch(/\[int\]\$ScanSpan = 50/);
  });

  it('still exits non-zero when a repo-owned listener survives the stop', () => {
    expect(scripts.stop).toContain('仍被本仓库的 dev 进程监听');
    expect(scripts.stop).toMatch(/if \(\$failures\.Count -gt 0\)/);
  });
});

describe('test-api.ps1 verifies the shutdown instead of assuming it (regression 7)', () => {
  it('re-checks the port and the runtime artefacts after the finally stop', () => {
    const finallyIndex = scripts.testApi.lastIndexOf('finally {');
    const finallyBlock = scripts.testApi.slice(finallyIndex);
    expect(finallyBlock).toContain('$artifacts.StopScript');
    // "Called stop-dev.ps1" is not the same as "the port is free".
    expect(finallyBlock).toContain('Wait-PortFree');
    expect(finallyBlock).toContain('$script:FinallyStopFailed = $true');
    expect(finallyBlock).toContain('收尾停机验证失败');
    expect(finallyBlock).toContain('收尾停机完成');
  });

  it('surfaces a fatal abort as a failed run (and offers the self-test hook)', () => {
    expect(scripts.testApi).toContain('$script:FatalMessage');
    expect(scripts.testApi).toContain('FATAL 运行被中断');
    expect(scripts.testApi).toMatch(/\[int\]\$AbortAfterStep = 0/);
    expect(scripts.testApi).toContain('回归自检注入的致命错误');
    // The abort must be thrown outside the per-step catch, i.e. after the PASS/FAIL branch.
    const abortIndex = scripts.testApi.indexOf('回归自检注入的致命错误');
    const passIndex = scripts.testApi.indexOf('PASS  "');
    expect(abortIndex).toBeGreaterThan(passIndex);
  });
});
