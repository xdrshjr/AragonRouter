/**
 * `src/components/brand/BrandMark.tsx` - component contract.
 *
 * Acceptance criterion 2 ("BrandMark exists, is used in three places, and its props are
 * `size?: number; withWordmark?: boolean`") and criterion 4 ("colours only from the C10
 * tokens") are verified at two levels:
 *
 *  - the *public API* is type-checked. `npx tsc --noEmit` includes `tests/**`, so the
 *    `@ts-expect-error` assertions below prove that `size` really is a number, that
 *    `withWordmark` really is a boolean and that no undocumented prop was added - a
 *    runtime render alone could never show that;
 *  - the *rendered markup* is asserted through `react-dom/server`, i.e. exactly the HTML
 *    a browser receives, with no jsdom and no new dependency.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { BrandMark, type BrandMarkProps } from '@/components/brand/BrandMark';
import { parseSvg, read, readTokenPalette } from './support/svg';

const SOURCE_PATH = 'src/components/brand/BrandMark.tsx';
const SOURCE = read(SOURCE_PATH);

// --- type-level evidence (checked by `npx tsc --noEmit`, not by the runner) ---------
const noProps: BrandMarkProps = {};
const explicitProps: BrandMarkProps = { size: 32, withWordmark: true };
// @ts-expect-error - `size` is a number
const sizeMustBeNumber: BrandMarkProps = { size: '32' };
// @ts-expect-error - `withWordmark` is a boolean
const wordmarkMustBeBoolean: BrandMarkProps = { withWordmark: 'yes' };
// @ts-expect-error - only the two documented props exist
const noExtraProps: BrandMarkProps = { size: 24, className: 'extra' };

function render(props: BrandMarkProps = {}): string {
  return renderToStaticMarkup(<BrandMark {...props} />);
}

describe('public API', () => {
  it('exports a function component called BrandMark', () => {
    expect(typeof BrandMark).toBe('function');
    expect(BrandMark.name).toBe('BrandMark');
    expect(SOURCE).toMatch(/export function BrandMark\(/);
  });

  it('documents exactly the two contracted props', () => {
    // The values are only here so the type assertions above are referenced, not dead code.
    expect([noProps, explicitProps, sizeMustBeNumber, wordmarkMustBeBoolean, noExtraProps]).toHaveLength(5);
    expect(explicitProps.size).toBe(32);
    expect(explicitProps.withWordmark).toBe(true);
  });

  it('is a server-renderable leaf: no client directive, no hooks, no imports but React types', () => {
    expect(SOURCE).not.toMatch(/^\s*['"]use client['"]/m);
    expect(SOURCE).not.toMatch(/\buse(State|Effect|Memo|Ref|Callback|Context|Reducer|LayoutEffect)\s*\(/);
    const imports = SOURCE.match(/import\s[^;]+;/g) ?? [];
    for (const statement of imports) {
      expect(statement).toMatch(/from\s+['"]react['"]/);
      expect(statement).toMatch(/^import type\s/);
    }
  });

  it('renders deterministically for the same props', () => {
    expect(render({ size: 24, withWordmark: true })).toBe(render({ size: 24, withWordmark: true }));
  });
});

describe('rendered markup', () => {
  it('defaults to a 24px square with a 32-unit viewBox', () => {
    const markup = render();
    expect(markup).toContain('<svg');
    expect(markup).toContain('width="24"');
    expect(markup).toContain('height="24"');
    expect(markup).toContain('viewBox="0 0 32 32"');
    // The mark is an inline SVG: no bitmap, no external asset, no canvas.
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<canvas');
    expect(markup).not.toMatch(/https?:\/\//);
    expect(markup).not.toContain('data:');
  });

  it.each([12, 20, 28, 32, 48, 256])('honours size=%i', (size) => {
    const markup = render({ size });
    expect(markup).toContain(`width="${size}"`);
    expect(markup).toContain(`height="${size}"`);
    expect(markup).not.toContain('NaN');
  });

  it.each([
    { input: 1, expected: 12, why: 'clamped to the 12px floor' },
    { input: 0, expected: 12, why: 'clamped to the 12px floor' },
    { input: -40, expected: 12, why: 'negative clamps to the floor' },
    { input: 1000, expected: 256, why: 'clamped to the 256px ceiling' },
    { input: 24.6, expected: 25, why: 'rounded to the pixel grid' },
    { input: Number.NaN, expected: 24, why: 'NaN falls back to the default' },
    { input: Number.POSITIVE_INFINITY, expected: 24, why: 'Infinity falls back to the default' },
  ])('normalises size=$input to $expected ($why)', ({ input, expected }) => {
    const markup = render({ size: input });
    expect(markup).toContain(`width="${expected}"`);
    expect(markup).toContain(`height="${expected}"`);
  });

  it('keeps the plate and the glyph square and un-scaled whatever the size is', () => {
    for (const size of [12, 24, 128]) {
      const markup = render({ size });
      // Same geometry at every size: only width/height change, never the viewBox.
      expect(markup.match(/viewBox="0 0 32 32"/g) ?? []).toHaveLength(1);
      expect(markup).not.toMatch(/transform=|scale\(/);
    }
  });
});

describe('accessibility', () => {
  it('labels the standalone mark as an image', () => {
    const markup = render();
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="AragonRouter"');
    expect(markup).not.toContain('aria-hidden');
    expect(markup).not.toContain('AragonRouter</span>');
  });

  it('marks the mark decorative once the wordmark carries the name', () => {
    const markup = render({ withWordmark: true });
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
    // The name appears exactly once, as text, so screen readers announce it once.
    expect(markup.match(/AragonRouter/g) ?? []).toHaveLength(1);
    expect(markup).toMatch(/<span[^>]*>AragonRouter<\/span>/);
  });

  it('uses the existing text token for the wordmark and no font of its own', () => {
    const markup = render({ withWordmark: true, size: 32 });
    expect(markup).toContain('text-text');
    expect(markup).not.toMatch(/font-family|@font-face|url\(/);
  });
});

describe('visual language', () => {
  it('fills the plate with the brand token and the glyph with the bg token', () => {
    const markup = render();
    expect(markup).toContain('fill="var(--brand)"');
    // The glyph is the dark bg value. It is pinned to the literal instead of
    // `var(--bg)` so the mark keeps its contrast when `.light` redefines `--bg`.
    expect(markup).toContain('fill="#121212"');
    const palette = readTokenPalette(read('src/app/globals.css'));
    expect(palette.brand).toBe('#3ecf8e');
    expect(palette.bg).toBe('#121212');
  });

  it('uses no colour outside the C10 palette', () => {
    const markup = render({ withWordmark: true });
    const literals = [...markup.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((match) =>
      (match[1] ?? '').toLowerCase(),
    );
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) expect(['#3ecf8e', '#121212']).toContain(literal);
    expect(markup).not.toMatch(/\b(rgb|hsl)a?\(/);
    expect(markup).not.toMatch(/fill="(?!var\(--brand\)|#[0-9a-fA-F]{3,8})/);
  });

  it('only references CSS variables that globals.css declares', () => {
    const css = read('src/app/globals.css');
    const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const referenced = [...SOURCE.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1] ?? '');
    expect(referenced.length).toBeGreaterThan(0);
    for (const token of referenced) {
      expect(rootBlock).toContain(`${token}:`);
    }
    expect(referenced).toContain('--brand');
  });

  it('draws flat shapes only: no gradient, filter, stroke or opacity in the markup', () => {
    const markup = render();
    expect(markup).not.toMatch(/Gradient|pattern|filter|mask|clipPath/i);
    expect(markup).not.toMatch(/\bopacity=/);
    expect(markup).not.toMatch(/\bstroke=/);
    // Two filled paths (the "A" and its crossbar) on one plate.
    expect((markup.match(/<path /g) ?? []).length).toBe(2);
    expect((markup.match(/<rect /g) ?? []).length).toBe(1);
  });

  it('reproduces the favicon geometry exactly', () => {
    const favicon = parseSvg(read('src/app/icon.svg'));
    const faviconPaths = favicon.children
      .filter((node) => node.name === 'path')
      .map((node) => node.attrs['d']);
    const componentPaths = [...SOURCE.matchAll(/<path\s+d="([^"]+)"/g)].map((match) => match[1]);
    expect(componentPaths).toEqual(faviconPaths);
    expect(componentPaths).toHaveLength(2);
  });
});
