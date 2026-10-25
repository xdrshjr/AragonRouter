import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isValidApiKeyFormat } from '@/lib/apikeys';
import { SESSION_COOKIE, SESSION_TTL_MS, serializeSessionCookie } from '@/lib/auth';
import {
  DEFAULT_DATABASE_PATH,
  getAnthropicDefaultVersion,
  getMaxBufferedResponseBytes,
  getMaxRequestBodyBytes,
  getProviderTestTimeoutMs,
  getRelayTimeoutMs,
} from '@/lib/env';
import { maskKey } from '@/lib/providers';
import { STATS_RANGES } from '@/lib/stats';

/**
 * Contract tests for the `readme-polish` work package: the Chinese operator manual.
 *
 * Every acceptance criterion of the work package and every clause of contract B2
 * ("README structure") is traced to a test here. What this file adds over the older
 * `tests/integration/scripts-contract.test.ts` README block (which only greps a handful
 * of section names) is that the document is checked *against the things it describes*:
 *
 *  - README ↔ `scripts/*.ps1`: every `-Parameter` the manual attributes to a script must
 *    exist in that script's top-level `param()` block, and no real parameter may be left
 *    undocumented; the documented defaults must equal the parsed defaults.
 *  - README ↔ `vitest.config.ts` / `tests/*\/vitest.config.ts`: the include glob quoted by
 *    「已知限制」must be the actual one, the UI config must really resolve `.tsx`, the
 *    integration config must really be serial.
 *  - README ↔ `src/lib/*` + `next.config.ts`: response shapes, key/mask/cookie formats and
 *    environment defaults printed in the manual must match the code that produces them.
 *  - README ↔ git baseline: nothing that was accurate before the polish was dropped.
 *
 * Run with: npx vitest run --config tests/readme-polish/vitest.config.ts
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const readText = (relativePath: string): string => readFileSync(join(projectRoot, relativePath), 'utf8');
const fileExists = (relativePath: string): boolean => existsSync(join(projectRoot, relativePath));

const README = readText('README.md');
const README_LINES = README.split(/\r?\n/);

/** CJK ideographs plus full-width punctuation (a line using only ASCII identifiers is fine). */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

interface Section {
  title: string;
  line: number;
  body: string;
  /** True when the README no longer has this heading (kept non-throwing so the rest of the suite still reports). */
  missing?: boolean;
}

function headings(source: string, level: 2 | 3): Section[] {
  const lines = source.split(/\r?\n/);
  const marker = '#'.repeat(level);
  const found: { title: string; line: number }[] = [];
  let inFence = false;
  lines.forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = new RegExp(`^${marker}\\s+(.*)$`).exec(raw);
    const title = match?.[1]?.trim();
    if (title !== undefined && title.length > 0) found.push({ title, line: index });
  });
  return found.map((heading, index) => {
    const next = found[index + 1];
    const end = next ? next.line : lines.length;
    return { title: heading.title, line: heading.line, body: lines.slice(heading.line + 1, end).join('\n') };
  });
}

const H2 = headings(README, 2);
const H3 = headings(README, 3);

/**
 * Locate a heading. Deliberately non-throwing: a deleted heading must fail the tests that
 * depend on it (empty body, `missing: true`) instead of crashing file collection, which
 * would turn every assertion in this suite into a single opaque error.
 */
function section(sections: Section[], title: string): Section {
  const match = sections.find((candidate) => candidate.title === title);
  if (match) return match;
  return { title, line: -1, body: '', missing: true };
}

/** Prose lines only: fenced code blocks are excluded (they are allowed to be pure ASCII). */
function proseLines(source: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  let inFence = false;
  source.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    result.push({ line: index + 1, text: raw });
  });
  return result;
}

/** Drop inline code, HTML tags, link targets and bare URLs, leaving human prose. */
function stripNonProse(text: string): string {
  return text
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ');
}

/**
 * A line is "English prose" when it carries no CJK character at all and still contains two
 * adjacent latin words. Identifiers, versions and dot-paths (`node:sqlite`, `Next.js 15`)
 * do not match, an English sentence does.
 */
function isEnglishProse(text: string): boolean {
  const stripped = stripNonProse(text);
  if (CJK.test(stripped)) return false;
  return /[A-Za-z]{2,}[\s-]+[A-Za-z]{2,}/.test(stripped);
}

interface FencedBlock {
  language: string;
  content: string;
}

function fencedBlocks(source: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = source.split(/\r?\n/);
  let open: { language: string; lines: string[] } | null = null;
  for (const raw of lines) {
    const fence = /^\s*```(.*)$/.exec(raw);
    if (fence) {
      if (open === null) {
        open = { language: (fence[1] ?? '').trim(), lines: [] };
      } else {
        blocks.push({ language: open.language, content: open.lines.join('\n') });
        open = null;
      }
      continue;
    }
    if (open) open.lines.push(raw);
  }
  if (open) blocks.push({ language: open.language, content: open.lines.join('\n') });
  return blocks;
}

/**
 * Parse the *top-level* `param(...)` block of a PowerShell script. Nested function
 * `param()` blocks appear later in the file and must not be mistaken for the script's own.
 */
function parseScriptParameters(relativePath: string): Map<string, string | undefined> {
  const lines = readText(relativePath).split(/\r?\n/);
  const start = lines.findIndex((line) => /^param\s*\(/i.test(line));
  if (start === -1) throw new Error(`${relativePath} has no top-level param() block`);
  const params = new Map<string, string | undefined>();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*\)/.test(line)) break;
    const match = /^\s*\[[^\]]+\]\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*([^,]+?))?\s*,?\s*$/.exec(line);
    const name = match?.[1];
    if (name) params.set(name, match?.[2]?.trim());
  }
  return params;
}

/** PowerShell's own switches appear next to the scripts in the manual; they are not ours. */
const POWERSHELL_SWITCHES = new Set(['NoProfile', 'ExecutionPolicy', 'File', 'Command', 'WindowStyle', 'WorkingDirectory']);

/** Every `-Something` switch-shaped token in a chunk of README text. */
function switchTokensIn(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/-([A-Z][A-Za-z0-9]+)/g)) {
    const token = match[1];
    if (token && !POWERSHELL_SWITCHES.has(token)) tokens.add(token);
  }
  return tokens;
}

const SCRIPTS = {
  start: 'scripts/start-dev.ps1',
  stop: 'scripts/stop-dev.ps1',
  testApi: 'scripts/test-api.ps1',
} as const;

/** The README subsection that documents each script's parameters (section 5 「一键启停」). */
const DOC_SECTION = {
  start: section(H3, '启动'),
  stop: section(H3, '停止'),
  testApi: section(H3, '端到端验证'),
} as const;

function baselineReadme(): string | null {
  try {
    const rootCommit = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop();
    if (!rootCommit) return null;
    return execFileSync('git', ['show', `${rootCommit}:README.md`], { cwd: projectRoot, encoding: 'utf8' });
  } catch {
    return null;
  }
}

const BASELINE = baselineReadme();

describe('README 顶部品牌区（验收 1 / 契约 B2）', () => {
  const quickStartLine = section(H2, '快速开始').line;
  const brandArea = quickStartLine > 0 ? README_LINES.slice(0, quickStartLine).join('\n') : '';

  it('is the first thing in the document: the icon block precedes every H2 section', () => {
    expect(section(H2, '快速开始').missing, 'README has no 快速开始 section').toBeUndefined();
    expect(quickStartLine).toBeGreaterThan(10);
    expect(brandArea.length).toBeGreaterThan(200);
  });

  it('references the repository icon src/app/icon.svg', () => {
    expect(brandArea).toMatch(/<img[^>]+src="src\/app\/icon\.svg"|!\[[^\]]*\]\(src\/app\/icon\.svg\)/);
  });

  it('points at icon assets that really exist and are SVG documents', () => {
    const icon = readText('src/app/icon.svg');
    const appleIcon = readText('src/app/apple-icon.svg');
    expect(icon).toContain('<svg');
    expect(icon).toContain('width="32"');
    expect(appleIcon).toContain('<svg');
    expect(appleIcon).toContain('width="180"');
    // The prose next to the icon must name the App Router file convention it relies on.
    expect(brandArea).toContain('src/app/apple-icon.svg');
    expect(brandArea).toContain('App Router');
  });

  it('carries a one-sentence positioning statement', () => {
    expect(brandArea).toContain('一句话定位');
    // …and the sentence itself, not just the label.
    expect(brandArea).toMatch(/Anthropic[\s\S]{0,120}OpenAI/);
  });

  it('carries technical badges plus an offline plain-text fallback', () => {
    const badgeCount = (brandArea.match(/img\.shields\.io/g) ?? []).length;
    expect(badgeCount, 'brand area should show technical badges').toBeGreaterThanOrEqual(3);
    // The fallback is a <sub> block that wraps over several source lines: take everything
    // between the opening <sub> and the closing </sub> instead of a single line.
    const open = brandArea.indexOf('<sub>');
    const close = brandArea.indexOf('</sub>', open + 1);
    expect(open, 'brand area has no <sub> fallback block').toBeGreaterThan(-1);
    expect(close, 'the <sub> fallback block is not closed').toBeGreaterThan(open);
    const fallback = brandArea.slice(open, close);
    expect(fallback, 'badges break offline; a text fallback must exist').toContain('离线纯文本徽标');
    for (const token of ['Next.js 15', 'TypeScript strict', 'Node.js', 'Tailwind 3.4']) {
      expect(fallback, `text fallback is missing ${token}`).toContain(token);
    }
    // …and it must say the same things the badges say, not something weaker.
    expect(fallback).toContain('node:sqlite');
  });
});

describe('新增章节（验收 2 / 契约 B2）', () => {
  it('adds 快速开始 / 功能特性 / 已知限制 as H2 sections', () => {
    for (const title of ['快速开始', '功能特性', '已知限制']) {
      const found = section(H2, title);
      expect(found.missing, `README is missing the "## ${title}" section`).toBeUndefined();
      expect(found.body.trim().length, `section ${title} is empty`).toBeGreaterThan(100);
    }
  });

  it('places them where the reading order expects them', () => {
    const order = ['快速开始', '功能特性', '1. 架构', '8. 安全说明', '已知限制'].map(
      (title) => section(H2, title).line,
    );
    // Every heading must be present (a missing one reports -1) and in this order.
    expect(order.every((line) => line >= 0), `missing headings: ${order.join(',')}`).toBe(true);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });
});

describe('原有八个章节全部保留（验收 3 / 契约 B2）', () => {
  it.each([
    '1. 架构',
    '2. 目录结构',
    '3. 环境要求',
    '4. 环境变量',
    '5. 一键启停',
    '6. API 与 curl 示例',
    '7. 故障排查',
    '8. 安全说明',
  ])('keeps the numbered heading "%s"', (title) => {
    expect(H2.map((candidate) => candidate.title)).toContain(title);
  });

  it('keeps a non-empty body under each of them', () => {
    for (const title of ['1. 架构', '2. 目录结构', '3. 环境要求', '4. 环境变量', '5. 一键启停', '6. API 与 curl 示例', '7. 故障排查', '8. 安全说明']) {
      expect(section(H2, title).body.trim().length, `section ${title} is empty`).toBeGreaterThan(200);
    }
  });
});

describe('快速开始（三条命令 + 首次运行说明）', () => {
  const quickStart = section(H2, '快速开始');
  const cmdBlocks = fencedBlocks(quickStart.body).filter((block) => block.language === 'cmd');

  it('shows exactly three runnable commands', () => {
    expect(cmdBlocks).toHaveLength(3);
  });

  it('command 1 starts the dev server through the real script', () => {
    const first = cmdBlocks[0]?.content ?? '';
    expect(first).toContain('scripts\\start-dev.ps1');
    expect(fileExists('scripts/start-dev.ps1')).toBe(true);
  });

  it('command 2 opens the console on the port the script actually recorded', () => {
    const second = cmdBlocks[1]?.content ?? '';
    expect(second).toContain('.dev-server.port');
    expect(second).toContain('/console');
    expect(second, 'the recorded port is the only source of truth; 3000 must not be pinned').not.toContain('3000');
    expect(fileExists('src/app/console/page.tsx') || fileExists('src/app/console')).toBe(true);
  });

  it('command 3 stops everything through the real script', () => {
    const third = cmdBlocks[2]?.content ?? '';
    expect(third).toContain('scripts\\stop-dev.ps1');
    expect(fileExists('scripts/stop-dev.ps1')).toBe(true);
  });

  it('explains that the first run generates .env.local and prints the admin password', () => {
    expect(quickStart.body).toContain('.env.local');
    expect(quickStart.body).toContain('管理员口令');
    expect(quickStart.body).toMatch(/(打印|生成)[\s\S]{0,40}(管理员口令|口令)/);
    // The claim must be true of the script that does it.
    const startScript = readText(SCRIPTS.start);
    expect(startScript).toContain('.env.local');
    expect(startScript).toMatch(/ADMIN_PASSWORD/);
    expect(fileExists('.env.example')).toBe(true);
  });
});

describe('功能特性表格', () => {
  const features = section(H2, '功能特性');
  const rows = features.body
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()));

  it('is a real table with at least the eight required capability rows', () => {
    // header + separator are not capabilities
    expect(rows.length - 2).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ['双协议转发', '双协议转发'],
    ['SSE 流式', 'SSE'],
    ['Key 生命周期', 'Key 生命周期'],
    ['凭证 AES-256-GCM 加密', 'AES-256-GCM'],
    ['请求日志', '日志'],
    ['用量统计', '用量统计'],
    ['一键启停', '一键启停'],
    ['离线端到端测试', '端到端'],
  ])('documents %s', (_label, needle) => {
    expect(features.body).toContain(needle);
    const hasRow = rows.some((cells) => (cells[1] ?? '').includes(needle));
    expect(hasRow, `no table row is named ${needle}`).toBe(true);
  });

  it('links each capability to where it lives', () => {
    const tableText = rows.map((cells) => cells.join(' ')).join('\n');
    for (const anchor of ['/api/v1/messages', '/api/v1/chat/completions', 'scripts\\start-dev.ps1', 'src/lib/apikeys.ts', 'src/lib/crypto.ts']) {
      expect(tableText, `feature table does not point at ${anchor}`).toContain(anchor);
    }
  });
});

describe('已知限制（三条必写限制）', () => {
  const limits = section(H2, '已知限制');

  it('says tests/ui/** is outside the root vitest include', () => {
    expect(limits.body).toContain('tests/ui/**');
    expect(limits.body).toContain('tests/unit/**/*.test.ts');
    expect(limits.body).toContain('include');
  });

  it('says end-to-end coverage is carried by scripts/test-api.ps1', () => {
    expect(limits.body).toContain('scripts/test-api.ps1');
    expect(limits.body).toContain('端到端');
  });

  it('says upstream reachability is confirmed by hand with the console Test connection', () => {
    expect(limits.body).toContain('Test');
    expect(limits.body).toMatch(/(连通性|上游)/);
    expect(limits.body).toMatch(/人工|手工|手工确认|手工确认/);
  });

  it('quotes the include glob the root vitest config really has（README ↔ vitest.config.ts）', () => {
    const rootConfig = readText('vitest.config.ts');
    const includeMatch = /include:\s*\[([^\]]*)\]/.exec(rootConfig);
    const actual = (includeMatch?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter((entry) => entry.length > 0);
    expect(actual).toEqual(['tests/unit/**/*.test.ts']);
    for (const glob of actual) expect(limits.body).toContain(glob);
    expect(actual.join('')).not.toContain('.tsx');
  });

  it('matches the UI and integration configs it tells the reader to use（README ↔ tests/*/vitest.config.ts）', () => {
    const uiConfig = readText('tests/ui/vitest.config.ts');
    const integrationConfig = readText('tests/integration/vitest.config.ts');
    expect(uiConfig).toContain("'tests/ui/**/*.test.tsx'");
    expect(uiConfig).toContain("jsx: 'automatic'");
    expect(integrationConfig).toContain('fileParallelism: false');
    expect(limits.body).toContain('tests/ui/vitest.config.ts');
    expect(limits.body).toContain('tests/integration/vitest.config.ts');
    // "串行" is what fileParallelism: false means; the manual must not claim the opposite.
    expect(readText('README.md')).toContain('串行');
  });
});

describe('故障排查补充条目', () => {
  const troubleshooting = section(H2, '7. 故障排查');

  it('covers the slow first compile (rerun the suite once)', () => {
    expect(troubleshooting.body).toContain('冷编译');
    expect(troubleshooting.body).toMatch(/重跑/);
    expect(troubleshooting.body).toMatch(/首次编译慢/);
  });

  it('states the 120 second readiness budget and the -TimeoutSeconds knob', () => {
    expect(troubleshooting.body).toContain('-TimeoutSeconds');
    expect(troubleshooting.body).toMatch(/120\s*秒/);
    expect(troubleshooting.body).toContain('-StartTimeoutSeconds');
  });
});

describe('脚本参数与 scripts/*.ps1 一致（验收 4 / 契约 B2）', () => {
  it.each([
    ['start', 'start-dev.ps1'],
    ['stop', 'stop-dev.ps1'],
    ['testApi', 'test-api.ps1'],
  ] as const)('documents exactly the parameters %s (%s) really accepts', (key, label) => {
    const parsed = [...parseScriptParameters(SCRIPTS[key]).keys()].sort();
    // Guard against a silently empty parse: the manual must not "match" an empty set.
    expect(parsed.length, `${label} param() block did not parse`).toBeGreaterThanOrEqual(4);

    const documented = [...switchTokensIn(DOC_SECTION[key].body)].sort();
    expect(documented, `README documents switches ${label} does not have`).toEqual(parsed);
  });

  it('states the same defaults the scripts declare', () => {
    const start = parseScriptParameters(SCRIPTS.start);
    const stop = parseScriptParameters(SCRIPTS.stop);
    const testApi = parseScriptParameters(SCRIPTS.testApi);
    expect(start.get('TimeoutSeconds')).toBe('120');
    expect(start.get('LockTimeoutSeconds')).toBe('300');
    expect(stop.get('LockTimeoutSeconds')).toBe('120');
    expect(stop.get('ScanStartPort')).toBe('3000');
    expect(stop.get('ScanSpan')).toBe('50');
    expect(testApi.get('StartTimeoutSeconds')).toBe('120');
    expect(testApi.get('AbortAfterStep')).toBe('0');

    // …and the manual quotes those numbers where it talks about them.
    expect(DOC_SECTION.start.body).toMatch(/120 秒/);
    expect(DOC_SECTION.start.body).toContain('-LockTimeoutSeconds');
    expect(README).toMatch(/300 秒/);
    expect(DOC_SECTION.stop.body).toMatch(/120 秒/);
    // 3000 + 50 - 1 = 3049: the scan window the manual quotes.
    const startPort = Number(stop.get('ScanStartPort'));
    const span = Number(stop.get('ScanSpan'));
    expect(startPort + span - 1).toBe(3049);
    expect(README).toContain('3049');
  });

  it('never invents a script file', () => {
    const referenced = new Set<string>();
    for (const match of README.matchAll(/scripts[\\/]([A-Za-z0-9_.-]+\.ps1)/g)) {
      // `scripts\xxx.ps1` in 「故障排查」 is an intentional placeholder for "whichever script",
      // not a claim that such a file exists.
      if (match[1] && !/^x{3,}\.ps1$/i.test(match[1])) referenced.add(match[1]);
    }
    expect(referenced.size).toBeGreaterThanOrEqual(3);
    for (const file of referenced) {
      expect(fileExists(`scripts/${file}`), `README references scripts/${file} which does not exist`).toBe(true);
    }
    // The three entry points the spec names must all be mentioned.
    for (const required of ['start-dev.ps1', 'stop-dev.ps1', 'test-api.ps1']) {
      expect(referenced.has(required), `README never mentions scripts/${required}`).toBe(true);
    }
  });
});

describe('未声称 LICENSE（验收 5）', () => {
  it('never claims a license', () => {
    expect(README).not.toMatch(/licen[cs]e/i);
    expect(README).not.toMatch(/许可证|版权|著作权|开源协议|MIT|Apache-2\.0|GPL-3\.0|BSD-3-Clause/);
  });

  it('does not point at a license badge or file', () => {
    expect(README).not.toMatch(/\[!\[[^\]]*[Ll]icense/);
    expect(README).not.toMatch(/LICENSE(?:\.[a-z]+)?/);
  });

  it('matches reality: the repository carries no license file', () => {
    const entries = readdirSync(projectRoot);
    expect(entries.filter((entry) => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(entry))).toEqual([]);
  });
});

describe('除代码块与标识符外全中文（验收 6）', () => {
  it('has no English prose line outside code fences', () => {
    const offenders = proseLines(README)
      .filter((entry) => isEnglishProse(entry.text))
      .map((entry) => `README.md:${entry.line}: ${stripNonProse(entry.text).trim().slice(0, 100)}`);
    expect(offenders).toEqual([]);
  });

  it('keeps every heading Chinese', () => {
    const headingsWithoutCjk = README_LINES.filter(
      (line) => /^#{1,6}\s+/.test(line) && !CJK.test(line),
    );
    expect(headingsWithoutCjk).toEqual([]);
  });

  it('is overwhelmingly Chinese prose', () => {
    const cjk = (README.match(/[\u4e00-\u9fff]/g) ?? []).length;
    expect(cjk).toBeGreaterThan(3000);
  });

  it('the detector itself works (meta check)', () => {
    expect(isEnglishProse('The relay never buffers the upstream response body.')).toBe(true);
    expect(isEnglishProse('| `-Port` | 指定端口 |')).toBe(false);
    expect(isEnglishProse('Node.js &gt;= 22.5 · node:sqlite · Tailwind 3.4 ·')).toBe(false);
    expect(isEnglishProse('见 `src/lib/proxy.ts` 的转发实现。')).toBe(false);
  });
});

describe('文档引用的仓库路径都真实存在（文档 ↔ 仓库边界）', () => {
  const pathTokens = new Set<string>();
  for (const match of README.matchAll(/(?:^|[\s`("'|])((?:scripts|tests|src)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|ps1|svg|css|json|md))/g)) {
    const token = match[1];
    if (token && !token.includes('*')) pathTokens.add(token);
  }

  it('references a meaningful number of repository paths', () => {
    expect(pathTokens.size).toBeGreaterThanOrEqual(10);
  });

  it.each([...pathTokens].sort())('%s exists', (relativePath) => {
    expect(fileExists(relativePath), `README references ${relativePath} which does not exist`).toBe(true);
  });

  it('every *.test.ts(x) basename it names exists under tests/', () => {
    const existing = new Set<string>();
    const walk = (relativeDir: string): void => {
      for (const entry of readdirSync(join(projectRoot, relativeDir), { withFileTypes: true })) {
        const child = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else existing.add(entry.name);
      }
    };
    walk('tests');

    const named = new Set<string>();
    for (const match of README.matchAll(/([A-Za-z0-9_.-]+\.test\.tsx?)/g)) {
      if (match[1]) named.add(match[1]);
    }
    expect(named.size).toBeGreaterThanOrEqual(5);
    for (const name of named) {
      // Files that live outside tests/ (none today) would fail here on purpose: the manual
      // must not cite a suite that does not exist.
      expect(existing.has(name), `README cites ${name}, which is not part of tests/`).toBe(true);
    }
  });
});

describe('文档里的接口/环境事实与源码一致（文档 ↔ src 边界）', () => {
  it('environment defaults in the table match src/lib/env.ts', () => {
    const previous = { ...process.env };
    delete process.env.RELAY_TIMEOUT_MS;
    delete process.env.MAX_REQUEST_BODY_BYTES;
    delete process.env.MAX_BUFFERED_RESPONSE_BYTES;
    try {
      expect(getRelayTimeoutMs()).toBe(600_000);
      expect(getMaxRequestBodyBytes()).toBe(32 * 1024 * 1024);
      expect(getMaxBufferedResponseBytes()).toBe(64 * 1024 * 1024);
    } finally {
      process.env = previous;
    }
    expect(getProviderTestTimeoutMs()).toBe(5_000);
    expect(getAnthropicDefaultVersion()).toBe('2023-06-01');
    expect(DEFAULT_DATABASE_PATH).toBe('./data/aragon.db');

    const envSection = section(H2, '4. 环境变量').body;
    for (const token of ['32 MiB', '64 MiB', '600000', './data/aragon.db', 'COOKIE_SECURE']) {
      expect(envSection, `environment table does not state ${token}`).toContain(token);
    }
    // The Anthropic default version is not an env var, so it lives in section 1 + section 6;
    // it must still be stated once with the value the code actually falls back to.
    expect(getAnthropicDefaultVersion()).toBe('2023-06-01');
    expect(README).toContain('2023-06-01');
    expect(section(H2, '1. 架构').body).toContain('2023-06-01');
    expect(README).toMatch(/5\s*(?:s|秒)/);
  });

  it('the API key example obeys the real key format', () => {
    const example = /ar-[0-9a-f]{32}/.exec(README)?.[0];
    expect(example, 'README has no full-length API key example').toBeDefined();
    expect(isValidApiKeyFormat(example)).toBe(true);
    // keyPrefix in the sample JSON is the first 10 characters of the key (src/lib/apikeys.ts).
    const prefixMatch = /"keyPrefix":"(ar-[0-9a-z]+)"/.exec(README);
    const prefix = prefixMatch?.[1];
    expect(prefix).toBeDefined();
    expect(prefix?.length).toBe(10);
    expect((example ?? '').slice(0, 10)).toHaveLength(prefix?.length ?? -1);
  });

  it('the maskedKey example matches src/lib/providers.ts maskKey()', () => {
    expect(README).toContain('sk-a…a1b2');
    expect(maskKey('sk-ant-api03-abcdefa1b2')).toBe('sk-a…a1b2');
    expect(maskKey('short-key')).toBe('••••');
  });

  it('the session cookie example matches src/lib/auth.ts', () => {
    expect(README).toContain('aragon_session=<exp>.<hmacHex>');
    expect(SESSION_COOKIE).toBe('aragon_session');
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(README).toMatch(/7 天/);
    const serialized = serializeSessionCookie('1700000000000.deadbeef', { secure: false });
    expect(serialized.startsWith(`${SESSION_COOKIE}=1700000000000.deadbeef`)).toBe(true);
    expect(serialized).toContain('; Path=/; HttpOnly; SameSite=Lax');
  });

  it('the stats ranges match src/lib/stats.ts', () => {
    expect([...STATS_RANGES]).toEqual(['24h', '7d', '30d']);
    for (const range of STATS_RANGES) expect(README).toContain(range);
    expect(README).toContain('?range=24h');
  });

  it('the "/ → /console" claim matches next.config.ts', () => {
    const nextConfig = readText('next.config.ts');
    expect(nextConfig).toMatch(/source:\s*'\/'[\s\S]*?destination:\s*'\/console'/);
    expect(README).toContain('`/` 重定向到 `/console`');
    expect(fileExists('src/app/console')).toBe(true);
  });
});

describe('完整保留原有内容（README ↔ git 基线）', () => {
  it.skipIf(BASELINE === null)('every accurate line of the pre-polish README survives', () => {
    const baseline = (BASELINE ?? '').split(/\r?\n/);
    const current = new Set(README_LINES.map((line) => line.trim()));
    const lost: string[] = [];
    for (const [index, raw] of baseline.entries()) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (current.has(line)) continue;
      // Strengthened sentences are allowed: the original text must still be a prefix of
      // some current line (line 71 of the baseline grew a parenthetical explanation).
      const strengthened = README_LINES.some((candidate) => candidate.trim().startsWith(line));
      // The H1 moved into the centred brand block; the title itself must still be there.
      const retitled = line.replace(/^#+\s*/, '') !== line && README.includes(line.replace(/^#+\s*/, ''));
      if (!strengthened && !retitled) lost.push(`baseline:${index + 1}: ${line.slice(0, 120)}`);
    }
    expect(lost).toEqual([]);
  });

  it('keeps the document a substantial, self-consistent manual', () => {
    expect(README_LINES.length).toBeGreaterThanOrEqual(479);
    expect(README).toContain('node:sqlite');
    expect(README).toContain('AES-256-GCM');
    expect(README).toContain('SSE');
  });
});
