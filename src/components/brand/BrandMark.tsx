/**
 * AragonRouter brand mark.
 *
 * The artwork is an AI-generated raster (Gemini image model) that
 * `design/build-brand-assets.py` projects onto the exact C10 duotone pair
 * (`#121212` plate + `#3ecf8e` accent) and downsamples into the icon set. This
 * component is the single place that consumes it, so the login card, the console
 * rail and the topbar can never drift apart.
 *
 * Why a plain `<img>` and not `next/image`: the asset is a fixed-size, already
 * optimised 512px PNG served from `public/`, it never needs responsive variants,
 * and `next/image` would drag `sharp` into the production runtime for a file that
 * is 33 KB on disk. The trade-off is losing the `@next/next/no-img-element` lint
 * hint, which is why the reasoning is recorded here.
 *
 * Regenerating the art:
 *   python design/build-brand-assets.py --source design/<master>.png
 */

/** Rendered edge length in CSS pixels. Clamped to 12-256, defaults to 24. */
const DEFAULT_SIZE = 24;
const MIN_SIZE = 12;
const MAX_SIZE = 256;

/** Served from `public/brand-mark.png` (512x512, duotone-normalised). */
const BRAND_MARK_SRC = '/brand-mark.png';

export interface BrandMarkProps {
  /** Rendered width/height in CSS pixels. Clamped to 12-256, defaults to 24. */
  size?: number;
  /** Renders the "AragonRouter" wordmark next to the mark. Defaults to false. */
  withWordmark?: boolean;
}

/**
 * Keep the mark square and on the pixel grid. A non-finite, non-positive or absurd
 * `size` falls back to the default instead of emitting `width="NaN"`.
 */
function normalizeSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));
}

/** Mark + optional wordmark, laid out inline so any parent flex row can host it. */
export function BrandMark({ size = DEFAULT_SIZE, withWordmark = false }: BrandMarkProps) {
  const dimension = normalizeSize(size);
  // With the wordmark the glyph is decorative (the text carries the name); on its
  // own it is the only accessible label, so it keeps a real alt text.
  const alt = withWordmark ? '' : 'AragonRouter';

  return (
    <span className="inline-flex select-none items-center gap-2">
      {/*
        `alt=""` plus `aria-hidden` keeps screen readers from announcing the logo
        twice when the wordmark is present. `shrink-0` stops the flex row from
        squashing the (square) mark into a rectangle.
      */}
      <img
        src={BRAND_MARK_SRC}
        width={dimension}
        height={dimension}
        alt={alt}
        aria-hidden={withWordmark ? true : undefined}
        decoding="async"
        className="shrink-0 rounded-[6px]"
        style={{ width: dimension, height: dimension }}
      />
      {withWordmark ? (
        <span
          className={
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
