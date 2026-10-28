/**
 * The visual contract of the account surface (WP acceptance: "样式只用既有设计系统与
 * tailwind 令牌，暗/亮主题都成立").
 *
 * Nothing here is a taste judgement. The console ships one hand-written design system
 * (`src/components/ui/**`) and one token palette whose dark/light symmetry is pinned by
 * `tests/ui/tokens.test.ts`. A screen that invents its own palette - a Tailwind default
 * colour, a raw `#rrggbb`, an `rgba()` inline style, or a `dark:`/`light:` override -
 * looks right in the theme the author happened to use and breaks in the other one.
 *
 * The files are enumerated, not listed by hand, so a module added to
 * `src/components/console/users/` tomorrow is covered by the same rule.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** Every source file this work package owns on the visual side. */
function accountSurfaceFiles(): string[] {
  const usersDir = join(ROOT, 'src/components/console/users');
  const modules = readdirSync(usersDir)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => `src/components/console/users/${name}`);
  return [
    'src/components/console/UsersPanel.tsx',
    'src/components/console/Sidebar.tsx',
    'src/components/console/SettingsPanel.tsx',
    'src/components/console/nav.ts',
    'src/app/console/users/page.tsx',
    ...modules,
  ].filter((file) => statSync(join(ROOT, file)).isFile());
}

const SURFACE = accountSurfaceFiles();

/** Tailwind's stock palette: reachable, but it is not this project's palette. */
const STOCK_PALETTE =
  '(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|' +
  'teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}';
const COLOUR_UTILITY =
  '(bg|text|border|ring|fill|stroke|divide|outline|from|to|via|shadow|decoration|caret|accent)';

describe('the account surface is painted with the shared design system', () => {
  it('covers the whole work package, not a sample of it', () => {
    expect(SURFACE).toContain('src/components/console/UsersPanel.tsx');
    expect(SURFACE).toContain('src/components/console/users/UsersTable.tsx');
    expect(SURFACE.length).toBeGreaterThanOrEqual(8);
  });

  it('the stock-palette guard can actually fail (no vacuous regex)', () => {
    const pattern = new RegExp(`${COLOUR_UTILITY}-${STOCK_PALETTE}\\b`);
    expect('rounded-md border border-border bg-surface px-2 text-muted').not.toMatch(pattern);
    expect('bg-[color:var(--danger-soft)] text-[11px]').not.toMatch(pattern);
    expect('bg-red-500').toMatch(pattern);
    expect('hover:text-gray-400').toMatch(pattern);
    expect('divide-slate-700').toMatch(pattern);
  });

  it('never uses a stock Tailwind colour, so both themes stay symmetric', () => {
    const pattern = new RegExp(`${COLOUR_UTILITY}-${STOCK_PALETTE}\\b`, 'g');
    for (const file of SURFACE) {
      const hits = read(file).match(pattern) ?? [];
      expect(hits, `${file} uses the stock palette: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('never hardcodes a colour value inline', () => {
    for (const file of SURFACE) {
      const source = read(file);
      expect(source, `${file} contains a hex colour`).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(source, `${file} contains a hex shorthand`).not.toMatch(/#[0-9a-fA-F]{3}\b/);
      expect(source, `${file} contains rgb()/hsl()`).not.toMatch(/\b(rgba?|hsla?)\(/);
      // A colour must come from the palette; anything else is a theme that only half works.
      expect(source, `${file} sets a colour through an inline style`).not.toMatch(
        /style=\{\{[^}]*(color|background)/,
      );
    }
  });

  it('never branches on the theme in a class, because the tokens already do', () => {
    for (const file of SURFACE) {
      const source = read(file);
      expect(source, `${file} uses a dark: override`).not.toMatch(/\bdark:[a-z]/);
      expect(source, `${file} uses a light: override`).not.toMatch(/\blight:[a-z]/);
    }
  });

  it('uses the semantic tokens the palette actually defines', () => {
    const config = read('tailwind.config.ts');
    // The token names this surface may paint with, straight from the palette mapping.
    for (const token of [
      'bg:',
      'surface:',
      "'surface-2':",
      'border:',
      "'border-strong':",
      'text:',
      'muted:',
      'brand:',
      "'on-brand':",
      'danger:',
      'warning:',
      'info:',
    ]) {
      expect(config, `tailwind.config.ts no longer maps ${token}`).toContain(token);
    }
    // And at least one file really uses them, so the palette is not merely declared.
    const joined = SURFACE.map((file) => read(file)).join('\n');
    for (const utility of ['text-muted', 'text-text', 'border-border', 'text-danger']) {
      expect(joined, `no account module paints with ${utility}`).toContain(utility);
    }
  });

  it('paints the soft backgrounds with tokens defined in BOTH themes', () => {
    const globals = read('src/app/globals.css');
    const used = new Set<string>();
    for (const file of SURFACE) {
      for (const match of read(file).matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        if (match[1]) used.add(match[1]);
      }
    }
    // Only the surface's own additions are interesting; the rest is the kit's business.
    const soft = [...used].filter((name) => name.endsWith('-soft') || name === '--overlay');
    expect(soft.length).toBeGreaterThan(0);
    const darkBlock = globals.slice(globals.indexOf(':root'), globals.indexOf('html.light'));
    const lightBlock = globals.slice(globals.indexOf('html.light'));
    for (const token of soft) {
      expect(darkBlock, `${token} is missing from the dark palette`).toContain(token);
      expect(lightBlock, `${token} is missing from the light palette`).toContain(token);
    }
  });
});

describe('the account surface reuses the kit instead of re-implementing it', () => {
  it('renders the table, the badges and the buttons from the design system', () => {
    const table = read('src/components/console/users/UsersTable.tsx');
    expect(table).toContain("from '@/components/ui/Table'");
    expect(table).toContain("from '@/components/ui/Badge'");
    expect(table).toContain("from '@/components/ui/Button'");
    expect(table).not.toMatch(/<table\b/);
    expect(table).not.toMatch(/<thead\b/);
  });

  it('puts every account dialog in the shared modal, not its own overlay', () => {
    for (const file of [
      'src/components/console/users/CreateUserDialog.tsx',
      'src/components/console/users/EditUserDialog.tsx',
      'src/components/console/users/ResetPasswordDialog.tsx',
    ]) {
      const source = read(file);
      expect(source, `${file} must use the shared Modal`).toContain("from '@/components/ui/Modal'");
      expect(source, `${file} must not build an overlay`).not.toMatch(/fixed inset-0/);
    }
  });

  it('deletes through the shared ConfirmDialog and toggles through the shared Switch', () => {
    const panel = read('src/components/console/UsersPanel.tsx');
    expect(panel).toContain('ConfirmDialog');
    expect(panel).toContain("from '@/components/ui/Toast'");
    const settings = read('src/components/console/SettingsPanel.tsx');
    expect(settings).toContain("from '@/components/ui/Switch'");
    expect(settings).toContain('toast.push');
  });
});
