/**
 * C10 design-token contract and the Tailwind/PostCSS wiring.
 *
 * C10 is a *shared contract* with a second consumer (`gw-hardening` reads the same
 * custom properties through `tailwind.config.ts`), so the exact values are pinned
 * here: a silent colour change would otherwise only be visible by eye.
 *
 * Everything is verified by reading the files as text - the tokens are the
 * source of truth, not something a render can report.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(repoPath(relative), 'utf8');
}

/** Expand `#fff` to `#ffffff` so equivalent spellings compare equal. */
function normalizeHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return trimmed;
}

/** Parse the declarations of the first block whose selector matches `selector`. */
function readBlock(css: string, selector: RegExp): Map<string, string> {
  const block = selector.exec(css);
  if (!block) throw new Error(`selector ${String(selector)} not found in globals.css`);
  const start = css.indexOf('{', block.index);
  const end = css.indexOf('}', start);
  const declarations = new Map<string, string>();
  for (const line of css.slice(start + 1, end).split(/\r?\n/)) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (match?.[1] && match[2]) declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

const globalsCss = read('src/app/globals.css');
const darkTokens = readBlock(globalsCss, /:root\s*\{/);
const lightTokens = readBlock(globalsCss, /^\s*html\.light\s*\{/m);

/** C10 dark palette, verbatim from the contract. */
const C10_DARK: Record<string, string> = {
  '--bg': '#121212',
  '--surface': '#171717',
  '--surface-2': '#1f1f1f',
  '--border': '#2a2a2a',
  '--border-strong': '#3a3a3a',
  '--text': '#ededed',
  '--text-muted': '#8f8f8f',
  '--brand': '#3ecf8e',
  '--brand-hover': '#24b47e',
  '--on-brand': '#04150d',
  '--danger': '#f04438',
  '--warning': '#f5a623',
  '--info': '#4d9dff',
};

/** C10 light palette (the symmetric values the contract names explicitly). */
const C10_LIGHT: Record<string, string> = {
  '--bg': '#ffffff',
  '--surface': '#f8f8f8',
  '--surface-2': '#f1f1f1',
  '--border': '#e5e5e5',
  '--text': '#1a1a1a',
  '--text-muted': '#6b6b6b',
};

describe('build tooling exists', () => {
  it('ships tailwind.config.ts, postcss.config.mjs and globals.css', () => {
    const config = read('tailwind.config.ts');
    const postcss = read('postcss.config.mjs');
    expect(config).toContain('content');
    expect(postcss).toContain('tailwindcss');
    expect(globalsCss).toContain('@tailwind base');
    expect(globalsCss).toContain('@tailwind components');
    expect(globalsCss).toContain('@tailwind utilities');
  });

  it('scans the files that actually use the classes', () => {
    const config = read('tailwind.config.ts');
    expect(config).toContain('./src/app/**/*.{ts,tsx}');
    expect(config).toContain('./src/components/**/*.{ts,tsx}');
  });

  it('does not pull a web font (C10 mandates the system stack)', () => {
    expect(globalsCss).not.toMatch(/@import\s+url\(/);
    // Match imports only: the C10 comment in globals.css mentions next/font by name.
    expect(globalsCss).not.toMatch(/from\s+['"]next\/font/);
    expect(read('src/app/layout.tsx')).not.toMatch(/from\s+['"]next\/font/);
    for (const file of ['tailwind.config.ts', 'src/app/globals.css']) {
      expect(read(file)).not.toMatch(/fonts\.googleapis|@font-face/);
    }
  });
});

describe('C10 dark palette is the default', () => {
  for (const [token, expected] of Object.entries(C10_DARK)) {
    it(`${token} is ${expected}`, () => {
      expect(darkTokens.has(token)).toBe(true);
      expect(normalizeHex(darkTokens.get(token) ?? '')).toBe(expected);
    });
  }

  it('declares the dark palette on :root, so the first paint is dark', () => {
    // Declaration order matters: the dark values must live in `:root`, not in a
    // `.dark` class, otherwise a browser without JavaScript renders light.
    expect(darkTokens.size).toBeGreaterThanOrEqual(Object.keys(C10_DARK).length);
    expect(globalsCss).toContain('color-scheme: dark');
  });
});

describe('C10 light palette is symmetric and opt-in', () => {
  for (const [token, expected] of Object.entries(C10_LIGHT)) {
    it(`${token} becomes ${expected} in the light theme`, () => {
      expect(lightTokens.has(token)).toBe(true);
      expect(normalizeHex(lightTokens.get(token) ?? '')).toBe(expected);
    });
  }

  it('flips color-scheme for native controls', () => {
    expect(globalsCss).toMatch(/html\.light\s*\{[^}]*color-scheme:\s*light/);
  });
});

describe('C10 typography, radii and backdrop', () => {
  it('uses a 6px control radius and an 8px card radius', () => {
    const config = read('tailwind.config.ts');
    expect(config).toMatch(/DEFAULT:\s*'6px'/);
    expect(config).toMatch(/card:\s*'8px'/);
    expect(darkTokens.get('--radius-control')).toBe('6px');
    expect(darkTokens.get('--radius-card')).toBe('8px');
  });

  it('keeps body copy at 13-14px and section labels at 11px uppercase', () => {
    expect(globalsCss).toMatch(/body\s*\{[^}]*font-size:\s*14px/);
    expect(globalsCss).toMatch(/\.label-caps\s*\{[^}]*font-size:\s*11px/);
    expect(globalsCss).toMatch(/\.label-caps\s*\{[^}]*text-transform:\s*uppercase/);
    // 13px is the small body size offered by the Tailwind scale.
    expect(read('tailwind.config.ts')).toMatch(/sm:\s*\['13px'/);
  });

  it('renders the dot-matrix backdrop with a token-driven colour', () => {
    expect(globalsCss).toMatch(/\.dot-grid\s*\{[^}]*radial-gradient/);
    expect(darkTokens.has('--dot')).toBe(true);
    expect(lightTokens.has('--dot')).toBe(true);
  });

  it('uses a system font stack, never a web font', () => {
    expect(globalsCss).toMatch(/font-family:\s*\r?\n?\s*-apple-system/);
    // The Tailwind stack spells the Windows fallback as a double-quoted "Segoe UI".
    expect(read('tailwind.config.ts')).toMatch(/Segoe UI/);
  });

  it('honours prefers-reduced-motion', () => {
    expect(globalsCss).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('tailwind maps every C10 colour onto its custom property', () => {
  const config = read('tailwind.config.ts');

  const mapping: Record<string, string> = {
    'bg:': 'var(--bg)',
    'surface:': 'var(--surface)',
    "'surface-2':": 'var(--surface-2)',
    'border:': 'var(--border)',
    "'border-strong':": 'var(--border-strong)',
    'text:': 'var(--text)',
    'muted:': 'var(--text-muted)',
    'brand:': 'var(--brand)',
    "'on-brand':": 'var(--on-brand)',
    'danger:': 'var(--danger)',
    'warning:': 'var(--warning)',
    'info:': 'var(--info)',
  };

  for (const [key, value] of Object.entries(mapping)) {
    it(`${key.trim()} resolves to ${value}`, () => {
      expect(config).toContain(key);
      expect(config).toContain(`'${value}'`);
    });
  }

  it('switches themes on the class strategy the console drives', () => {
    expect(config).toContain("darkMode: ['class']");
  });
});
