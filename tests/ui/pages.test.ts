/**
 * Page-level acceptance checks for the console.
 *
 * The work package may not add a test-only dependency (no jsdom, no
 * testing-library: the spec forbids expanding the dependency set), so the pages are
 * verified two ways:
 *   - their *behaviour* through the extracted pure modules (`api.ts`, `chart.ts`,
 *     `format.ts`, `log-query.ts`, `theme.ts`, `validation.ts`, `session-gate.ts`),
 *     which is where every decision actually lives;
 *   - their *structure* here, by reading the sources: which endpoint each page
 *     calls, that the overview really renders four KPI cards plus an inline SVG,
 *     that the settings page only reads, and that the console never imports
 *     `src/lib` or hard-codes Chinese copy.
 *
 * This is static evidence on purpose - it is stated as such in the traceability
 * rows, never as a rendered-DOM assertion.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/** Every `.ts`/`.tsx` file under a console-owned source directory. */
function sourceFiles(relativeDir: string): string[] {
  const root = join(SRC, relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(join(relativeDir, entry).replace(/\\/g, '/')));
    } else if (/\.tsx?$/.test(entry)) {
      files.push(join(relativeDir, entry).replace(/\\/g, '/'));
    }
  }
  return files;
}

const COMPONENT_FILES = [...sourceFiles('components')];
const PAGE_FILES = [
  'app/layout.tsx',
  ...sourceFiles('app/login'),
  ...sourceFiles('app/console'),
];

describe('console file inventory', () => {
  it('has a page for every route in the specification', () => {
    for (const page of [
      'app/login/page.tsx',
      'app/login/LoginForm.tsx',
      'app/layout.tsx',
      'app/globals.css',
      'app/console/layout.tsx',
      'app/console/page.tsx',
      'app/console/keys/page.tsx',
      'app/console/providers/page.tsx',
      'app/console/logs/page.tsx',
      'app/console/settings/page.tsx',
    ]) {
      expect(() => read(page)).not.toThrow();
    }
  });

  it('ships the full UI kit required by the work package', () => {
    for (const primitive of [
      'Button',
      'Card',
      'Input',
      'Label',
      'Select',
      'Switch',
      'Badge',
      'Table',
      'Modal',
      'Toast',
      'Tabs',
      'EmptyState',
      'Spinner',
    ]) {
      const source = read(`components/ui/${primitive}.tsx`);
      expect(source.length).toBeGreaterThan(200);
    }
    const barrel = read('components/ui/index.ts');
    for (const name of [
      'Button',
      'Card',
      'Input',
      'Label',
      'Select',
      'Switch',
      'Badge',
      'Table',
      'Modal',
      'ToastProvider',
      'Tabs',
      'EmptyState',
      'Spinner',
    ]) {
      expect(barrel).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('keeps its own copy of the API contract types', () => {
    const types = read('components/console/types.ts');
    for (const shape of [
      'ApiKeyPublic',
      'ProviderPublic',
      'StatsPayload',
      'RequestLogPublic',
      'ProviderTestResult',
      'LogFilters',
    ]) {
      expect(types).toMatch(new RegExp(`export interface ${shape}\\b`));
    }
    // C7 errorRate is a rounded fraction; C8 rows carry `stream` and `error`.
    expect(types).toContain('errorRate: number');
    expect(types).toContain('nextCursor');
  });
});

describe('module boundaries', () => {
  it('never imports src/lib from a console component or page', () => {
    const offenders = [...COMPONENT_FILES, ...PAGE_FILES].filter((file) => {
      const source = read(file);
      return /from\s+['"](@\/lib|\.\.\/.*lib|src\/lib)/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('reaches the backend only through /api/admin/**', () => {
    const api = read('components/console/api.ts');
    expect(api).toContain("ADMIN_API_BASE = '/api/admin'");
    const fetchers = [...COMPONENT_FILES, ...PAGE_FILES].filter((file) => /\bfetch\(/.test(read(file)));
    // One fetch call site for the whole console: the typed client.
    expect(fetchers).toEqual(['components/console/api.ts']);
  });

  it('keeps every admin call same-origin, uncached and cookie-bearing', () => {
    const api = read('components/console/api.ts');
    expect(api).toContain("credentials: 'same-origin'");
    expect(api).toContain("cache: 'no-store'");
  });

  it('uses no chart library (inline SVG only)', () => {
    for (const file of COMPONENT_FILES) {
      const source = read(file);
      expect(source).not.toMatch(/from\s+['"](recharts|chart\.js|react-chartjs-2|d3|victory|@visx|apexcharts)/);
    }
  });

  it('has no hard-coded Chinese copy, and no locale-dependent formatting', () => {
    const offenders: string[] = [];
    for (const file of [...COMPONENT_FILES, ...PAGE_FILES, 'app/globals.css']) {
      const source = read(file);
      if (/[\u4e00-\u9fff]/.test(source)) offenders.push(`${file}: CJK text`);
      // `toLocaleString` would render differently per machine and break hydration.
      // (A bare mention in a comment has no leading dot, so it does not match.)
      if (/\.toLocale(String|DateString|TimeString)\(/.test(source)) {
        offenders.push(`${file}: locale call`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('/login', () => {
  const page = read('app/login/page.tsx');
  const form = read('app/login/LoginForm.tsx');

  it('sanitises ?next= on the server before it reaches the client', () => {
    expect(page).toContain('sanitizeNextPath');
    expect(page).toMatch(/<LoginForm nextPath=\{nextPath\}/);
  });

  it('renders the same form component the console dialog uses', () => {
    expect(form).toContain('<AuthForm');
    expect(read('components/auth/LoginModal.tsx')).toContain('<AuthForm');
    // The credentials go through the C-AUTH-WIRE client, captcha included.
    expect(read('components/auth/auth-submit.ts')).toContain("from '@/components/console/api'");
  });

  it('sends the account to the sanitised target after a successful sign-in', () => {
    expect(form).toContain('router.replace(nextPath)');
    expect(form).toContain('router.refresh()');
    // No C3-only password POST survives: the page signs in with username+password.
    expect(form).not.toContain('signIn(');
  });

  it('shows failures inline instead of an alert dialog', () => {
    expect(form).not.toMatch(/\bwindow\.alert\b/);
    expect(read('components/auth/AuthForm.tsx')).toMatch(/role="alert"/);
    // Every control is bound to its message through the kit's `Field`.
    expect(read('components/auth/AuthForm.tsx')).toContain('aria-describedby={describedBy}');
  });

  it('never echoes the typed password back into a message', () => {
    const auth = read('components/auth/AuthForm.tsx');
    expect(auth).not.toMatch(/setErrors?\([^)]*password\b/);
    expect(auth).toContain("password: ''");
    const submit = read('components/auth/auth-submit.ts');
    // Only the policy/a field message is surfaced - never the value itself.
    expect(submit).not.toContain('input.password');
  });

  it('explains an expired session instead of pretending the visitor is new', () => {
    expect(page).toContain('hasSessionCookieShape');
    expect(page).toContain('sessionExpiredHint');
  });

  it('is guest first: the console shell no longer redirects anywhere', () => {
    const layout = read('app/console/layout.tsx');
    expect(layout).toContain('<AuthProvider>');
    expect(layout).toContain('<AuthGuard>');
    expect(layout).not.toContain('requireSession');
    expect(layout).not.toContain('redirect(');

    const guard = read('components/console/AuthGuard.tsx');
    expect(guard).toContain('useAuth()');
    expect(guard).toContain('<GuestMask');
    expect(guard).toContain('<AdminRequiredMask');
    expect(guard).not.toContain('getSession(');
    expect(guard).not.toContain("router.replace(");
    // A guest never mounts the panels: the mask is returned before `children`.
    expect(guard).toMatch(/if \(isGuest\) \{[\s\S]*?<GuestMask[\s\S]*?\n  \}/);
  });
});

describe('/console overview', () => {
  const panel = read('components/console/OverviewPanel.tsx');
  const chart = read('components/console/UsageChart.tsx');

  it('renders exactly four KPI cards', () => {
    const cards = panel.match(/<StatCard\b/g) ?? [];
    expect(cards).toHaveLength(4);
    for (const label of ['Requests', 'Error rate', 'Avg latency', 'Tokens']) {
      expect(panel).toContain(`label="${label}"`);
    }
  });

  it('loads C7 statistics and C8 recent requests', () => {
    expect(panel).toContain('getStats(');
    expect(panel).toContain('listLogs(');
    expect(panel).toContain('<LogTable');
    expect(panel).toContain('STATS_RANGES');
  });

  it('draws the usage chart as inline SVG, not an image or a canvas', () => {
    expect(chart).toContain('<svg');
    expect(chart).toContain('role="img"');
    expect(chart).toContain('buildSeriesGeometry');
    expect(chart).not.toContain('<canvas');
    expect(chart).not.toContain('<img');
  });
});

describe('/console/keys', () => {
  const panel = read('components/console/KeysPanel.tsx');

  it('creates, lists and revokes through C5', () => {
    expect(panel).toContain('createKey(');
    expect(panel).toContain('listKeys');
    expect(panel).toContain('revokeKey(');
  });

  it('reveals the plaintext once in a copy dialog and never in the list', () => {
    expect(panel).toContain('<CopyButton');
    expect(panel).toContain('created.key');
    expect(panel).toContain('This is the only time the full key is displayed');
    // The list renders the prefix with an ellipsis; `row.key` must not exist.
    expect(panel).toContain('{row.keyPrefix}…');
    expect(panel).not.toMatch(/row\.key\b/);
  });

  it('asks for confirmation before revoking', () => {
    expect(panel).toContain('<ConfirmDialog');
    expect(panel).toContain('destructive');
  });
});

describe('/console/providers', () => {
  const panel = read('components/console/ProvidersPanel.tsx');
  const api = read('components/console/api.ts');

  it('supports create, update and delete through C6', () => {
    expect(panel).toContain('createProvider(');
    expect(panel).toContain('updateProvider(');
    expect(panel).toContain('deleteProvider(');
  });

  it('toggles enabled with a switch bound to PATCH', () => {
    expect(panel).toContain('<Switch');
    expect(panel).toContain('updateProvider(provider.id, { enabled })');
    expect(panel).toContain('onCheckedChange');
  });

  it('tests connectivity against /api/admin/providers/[id]/test', () => {
    expect(panel).toContain('testProvider(');
    expect(api).toContain('`/providers/${encodeURIComponent(id)}/test`');
    expect(api).toContain("method: 'POST'");
  });

  it('shows the masked key only and lets an edit keep the stored one', () => {
    expect(panel).toContain('provider.maskedKey');
    expect(panel).toContain('Leave the API key blank');
    expect(panel).not.toMatch(/provider\.apiKey\b/);
  });
});

describe('/console/logs', () => {
  const panel = read('components/console/LogsPanel.tsx');
  const api = read('components/console/api.ts');

  it('filters by status and model', () => {
    expect(panel).toContain('STATUS_FILTER_OPTIONS');
    expect(panel).toContain('setStatus');
    expect(panel).toContain('normalizeModelFilter');
    expect(panel).toContain('modelInput');
  });

  it('loads more with the cursor the previous page returned', () => {
    expect(panel).toContain('nextCursor');
    expect(panel).toContain('Load more');
    expect(panel).toContain('mergeLogPages');
    expect(api).toContain('buildLogsQuery(input)');
  });

  it('debounces the model filter instead of firing per keystroke', () => {
    expect(panel).toMatch(/MODEL_DEBOUNCE_MS\s*=\s*\d+/);
    expect(panel).toContain('setTimeout');
  });
});

describe('/console/settings', () => {
  const panel = read('components/console/SettingsPanel.tsx');

  it('is read-only: it lists keys and providers and mutates nothing', () => {
    expect(panel).toContain('listKeys');
    expect(panel).toContain('listProviders');
    for (const mutation of ['createKey', 'revokeKey', 'createProvider', 'updateProvider', 'deleteProvider']) {
      expect(panel).not.toContain(`${mutation}(`);
    }
    expect(panel).not.toContain('useAsyncAction');
    expect(panel).toContain('Read-only');
  });

  it('documents C1 variable names without exposing a single value', () => {
    for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_PATH']) {
      expect(panel).toContain(name);
    }
    expect(panel).toContain("display: 'hidden'");
  });

  it('never renders a secret read from the environment', () => {
    expect(panel).not.toContain('process.env');
  });
});
