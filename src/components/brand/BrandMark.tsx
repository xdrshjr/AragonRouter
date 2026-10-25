import type { ReactNode } from 'react';

/**
 * AragonRouter brand mark (C10).
 *
 * A single, dependency-free inline SVG so the same identity renders on the login
 * screen, in the console rail and in the topbar without shipping an image asset:
 *
 *  - the plate is filled with the C10 `--brand` token (`#3ecf8e`) and the glyph with
 *    `#121212` written literally: that is the dark-theme `--bg` value, pinned instead
 *    of `var(--bg)` on purpose, because `.light` redefines `--bg` to `#ffffff` and a
 *    white glyph on the green plate would lose its contrast;
 *  - the geometry is the favicon geometry (`src/app/icon.svg`): a truncated-apex
 *    "A" with a bridging crossbar, flat shapes only, still legible at 16x16;
 *  - no web font, no external image, no bitmap payload - the wordmark is the C10
 *    system font stack inherited from `globals.css`.
 *
 * It is a plain function component with no hooks, no `'use client'` and no browser
 * API, so it renders in server components (`/login`) *and* inside the client shell
 * (`Sidebar` / `Topbar`) without creating a client boundary.
 */

export interface BrandMarkProps {
  /** Rendered width/height in CSS pixels. Clamped to 12-256, defaults to 24. */
  size?: number;
  /** Renders the "AragonRouter" wordmark next to the mark. Defaults to false. */
  withWordmark?: boolean;
}

const DEFAULT_SIZE = 24;
const MIN_SIZE = 12;
const MAX_SIZE = 256;

/**
 * Keep the mark square and on the pixel grid. A non-finite, non-positive or absurd
 * `size` falls back to the default instead of emitting `width="NaN"`.
 */
function normalizeSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));
}

/** Mark + optional wordmark, laid out inline so any parent flex row can host it. */
export function BrandMark({ size = DEFAULT_SIZE, withWordmark = false }: BrandMarkProps): ReactNode {
  const dimension = normalizeSize(size);
  // With the wordmark the glyph is decorative (the text carries the name); on its
  // own it is the only accessible label, so it becomes an image with an aria-label.
  const decorative = withWordmark;

  return (
    <span className="inline-flex select-none items-center gap-2">
      <svg
        width={dimension}
        height={dimension}
        viewBox="0 0 32 32"
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : 'AragonRouter'}
        aria-hidden={decorative ? true : undefined}
        className="shrink-0"
      >
        <rect width="32" height="32" rx="7" fill="var(--brand)" />
        {/* Truncated-apex "A": flat crystalline top, sharp shoulders, deep inner notch. */}
        <path d="M14.1 6H17.9L26 25.8H21.4L16 12.6L10.6 25.8H6Z" fill="#121212" />
        {/* Crossbar, bridging the notch without touching the plate edge. */}
        <path d="M12.4 17.4H19.6V20.8H12.4Z" fill="#121212" />
      </svg>
      {withWordmark ? (
        <span
          className={
            // 28px is the lockup threshold: from there the mark is as tall as a
            // 24px line box, so the wordmark can use the larger `text-base` step
            // without out-growing the mark (login 32, rail 28); below it (e.g. a
            // compact 20px header mark) `text-sm` keeps both on the same line.
            dimension >= 28
              ? 'whitespace-nowrap text-base font-semibold leading-6 text-text'
              : 'whitespace-nowrap text-sm font-semibold leading-5 text-text'
          }
        >
          AragonRouter
        </span>
      ) : null}
    </span>
  );
}
