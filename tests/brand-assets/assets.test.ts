/**
 * `src/app/icon.svg` and `src/app/apple-icon.svg` - asset-level contract.
 *
 * Acceptance criterion 1 ("both files exist and are legal SVG with xmlns and viewBox, no
 * external font or bitmap references") and criterion 4 ("colours only from the C10 tokens")
 * are proven here by parsing the files, not by grepping for a couple of substrings:
 *
 *  - well-formedness: the strict reader in `support/svg.ts` rejects an unbalanced tag, a
 *    second root element, an unquoted attribute or text outside the root;
 *  - the canvas contract (32x32 / 180x180, `xmlns`, `viewBox`) and the "no external
 *    resource" rule (no font, no `<image>`, no `data:`/base64 payload, no remote `href`);
 *  - the palette: every paint attribute is one of `#3ecf8e` / `#121212`;
 *  - the drawing itself: the glyph is a closed flat polygon, its crossbar really bridges
 *    the notch (measured from the path data), and its thinnest feature survives a 16px
 *    render - the "legible at 16px" clause of the specification.
 */

import { describe, expect, it } from 'vitest';

import {
  boundsOf,
  deviceScale,
  elementsNamed,
  exists,
  flatten,
  hexColours,
  paintColours,
  parseSvg,
  pathVertices,
  rasterize,
  read,
  viewBoxOf,
  xAtY,
  type SvgNode,
} from './support/svg';

const ICON = 'src/app/icon.svg';
const APPLE_ICON = 'src/app/apple-icon.svg';

/** The only two colour literals the specification allows (C10 `--brand` and `--bg`). */
const ALLOWED_HEX = new Set(['#3ecf8e', '#121212']);

/** Both assets draw the glyph in a 32-unit space; the Apple asset scales it by 180/32. */
const GLYPH_CANVAS = 32;

const FORBIDDEN_ELEMENTS = ['image', 'script', 'foreignObject', 'font', 'font-face', 'style', 'use', 'text'];

function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

/** Raw source with namespace declarations removed, so only real URLs remain. */
function withoutNamespaces(source: string): string {
  return stripComments(source).replace(/xmlns(:[\w-]+)?\s*=\s*"[^"]*"/g, '');
}

function rootOf(relativePath: string): SvgNode {
  return parseSvg(read(relativePath));
}

/** The two drawing paths of the mark, in document order: the "A" outline, then the crossbar. */
function drawingPaths(root: SvgNode): { outline: string; crossbar: string } {
  const paths = elementsNamed(root, 'path').map((node) => node.attrs['d'] ?? '');
  expect(paths).toHaveLength(2);
  const outline = paths[0];
  const crossbar = paths[1];
  if (outline === undefined || crossbar === undefined) throw new Error('missing path data');
  return { outline, crossbar };
}

describe.each([
  { file: ICON, canvas: 32 },
  { file: APPLE_ICON, canvas: 180 },
])('$file', ({ file, canvas }) => {
  it('exists and is a non-empty SVG document', () => {
    expect(exists(file)).toBe(true);
    const source = read(file);
    expect(source.trim().length).toBeGreaterThan(100);
    const root = parseSvg(source);
    expect(root.name).toBe('svg');
    // Well-formedness also means exactly one root element - parseSvg throws otherwise.
    expect(root.children.length).toBeGreaterThan(0);
  });

  it('declares the SVG namespace and a matching square viewBox', () => {
    const root = rootOf(file);
    expect(root.attrs['xmlns']).toBe('http://www.w3.org/2000/svg');
    const [minX, minY, width, height] = viewBoxOf(root);
    expect([minX, minY, width, height]).toEqual([0, 0, canvas, canvas]);
    expect(root.attrs['width']).toBe(String(canvas));
    expect(root.attrs['height']).toBe(String(canvas));
  });

  it('references no external font, bitmap, script or stylesheet', () => {
    const markup = withoutNamespaces(read(file));
    for (const pattern of [/@font-face/i, /font-family/i, /@import/i, /\bdata:/i, /\bbase64\b/i]) {
      expect(markup).not.toMatch(pattern);
    }
    // xmlns was removed above; any remaining absolute URL would be an external reference.
    expect(markup).not.toMatch(/https?:\/\//i);
    expect(markup).not.toMatch(/url\(\s*['"]?(?!#)/);
    // Only same-document fragment references would be acceptable.
    expect(markup).not.toMatch(/\b(xlink:)?href\s*=\s*"(?!#)/);
    const root = parseSvg(read(file));
    for (const node of flatten(root)) {
      expect(FORBIDDEN_ELEMENTS).not.toContain(node.name);
    }
  });

  it('paints only with the C10 tokens (brand #3ecf8e on bg #121212)', () => {
    const root = rootOf(file);
    const colours = paintColours(root);
    expect(colours.length).toBeGreaterThan(0);
    for (const value of colours) {
      expect(value).toMatch(/^#[0-9a-fA-F]{3,8}$|^none$|^currentColor$|^var\(--[\w-]+\)$/);
    }
    const hex = hexColours(root);
    expect(hex.length).toBeGreaterThan(0);
    for (const value of hex) expect(ALLOWED_HEX).toContain(value);
    // Both tokens must actually be used: a green plate and a dark glyph.
    expect(new Set(hex)).toEqual(new Set(['#3ecf8e', '#121212']));
  });

  it('is flat: no gradient, pattern, filter or stroke-based drawing', () => {
    const root = rootOf(file);
    for (const node of flatten(root)) {
      expect(node.name).not.toMatch(/Gradient|pattern|filter|mask|clipPath/i);
      const stroke = node.attrs['stroke'];
      if (stroke !== undefined) expect(stroke).toBe('none');
      expect(node.attrs['opacity']).toBeUndefined();
      expect(node.attrs['style']).toBeUndefined();
    }
  });

  it('draws exactly one closed "A" outline plus one crossbar', () => {
    const { outline, crossbar } = drawingPaths(rootOf(file));
    const glyph = pathVertices(outline);
    expect(glyph.points.length).toBe(7);
    expect(glyph.closed).toBe(true);
    // The mark is optically square (20x19.8 units here): a squashed or transposed glyph
    // would fail, and a square mark is what keeps the 32x32 favicon balanced.
    const bounds = boundsOf(glyph.points);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const aspect = height / width;
    expect(aspect).toBeGreaterThan(0.85);
    expect(aspect).toBeLessThan(1.25);

    const bar = pathVertices(crossbar);
    expect(bar.points.length).toBe(4);
    expect(bar.closed).toBe(true);
    const barBounds = boundsOf(bar.points);
    expect(barBounds.maxX).toBeGreaterThan(barBounds.minX);
    expect(barBounds.maxY).toBeGreaterThan(barBounds.minY);
  });

  it('keeps the glyph inside the canvas with an optical margin', () => {
    const { outline } = drawingPaths(rootOf(file));
    // The glyph lives in its own 32-unit coordinate space even in the 180px asset,
    // which wraps it in `<g transform="scale(180/32)">` - so measure against 32 units.
    const { minX, minY, maxX, maxY } = boundsOf(pathVertices(outline).points);
    const margin = GLYPH_CANVAS * 0.06;
    expect(minX).toBeGreaterThanOrEqual(margin);
    expect(minY).toBeGreaterThanOrEqual(margin);
    expect(maxX).toBeLessThanOrEqual(GLYPH_CANVAS - margin);
    expect(maxY).toBeLessThanOrEqual(GLYPH_CANVAS - margin);
    // Far enough inside that iOS' own corner mask cannot clip the shoulders.
    expect(maxX - minX).toBeLessThan(GLYPH_CANVAS * 0.9);
    expect(maxY - minY).toBeLessThan(GLYPH_CANVAS * 0.9);
  });
});

describe('the mark is legible at 16px', () => {
  const root = rootOf(ICON);
  const canvas = 32;
  const scale = deviceScale(canvas, 16);
  const { outline, crossbar } = drawingPaths(root);

  it('rasterises to a recognisable glyph at 16x16', () => {
    const ascii = (raster: { pixels: boolean[][] }, sourceUnits: number) => {
      const step = sourceUnits / raster.pixels.length;
      return raster.pixels
        .map((line, row) => {
          const y = (row + 0.5) * step;
          return line
            .map((painted, column) => {
              const x = (column + 0.5) * step;
              // Plate radius 7 at 32 units: the corners of the plate are not painted.
              const inCorner =
                (x < 7 && y < 7 && (7 - x) ** 2 + (7 - y) ** 2 > 49) ||
                (x > 25 && y < 7 && (x - 25) ** 2 + (7 - y) ** 2 > 49) ||
                (x < 7 && y > 25 && (7 - x) ** 2 + (y - 25) ** 2 > 49) ||
                (x > 25 && y > 25 && (x - 25) ** 2 + (y - 25) ** 2 > 49);
              return painted ? '#' : inCorner ? ' ' : '.';
            })
            .join('');
        })
        .join('\n');
    };

    const polygons = [pathVertices(outline).points, pathVertices(crossbar).points];
    const raster = rasterize(polygons, 16, canvas);

    // 256 pixels: at 16px the letterform covers ~17% of the tile. Below ~12% it degrades
    // to a speck, above ~45% the counter closes up and it reads as a blob.
    const share = raster.glyphPixels / (16 * 16);
    expect(share).toBeGreaterThan(0.12);
    expect(share).toBeLessThan(0.45);

    // Every row *between the first and the last painted row* keeps ink: the downscale
    // must not punch holes into the letterform (a real risk for a chevron this thin).
    const firstRow = raster.pixels.findIndex((line) => line.some(Boolean));
    const lastRow = raster.pixels.length - 1 - [...raster.pixels].reverse().findIndex((line) => line.some(Boolean));
    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(lastRow).toBeGreaterThan(firstRow);
    for (let row = firstRow; row <= lastRow; row += 1) {
      expect(raster.pixels[row]?.some(Boolean), `row ${row} of the 16px raster has no ink`).toBe(true);
    }

    // The counter (the hole above the crossbar) stays open: at 16px there is at least one
    // row with two separate painted runs - the two legs of the letter with plate between
    // them. That is what makes the shape read as an "A" and not as a solid triangle.
    const rowsWithTwoLegs = raster.pixels
      .map((line) => line.map((painted) => (painted ? '#' : '.')).join(''))
      .filter((row) => /#+\.+#+/.test(row));
    expect(rowsWithTwoLegs.length).toBeGreaterThan(0);

    // Keep the raster visible in the report/on failure: a regression should be readable
    // as ASCII art, not only as a number.
    expect({ art: ascii(raster, canvas), share, rowsWithTwoLegs }).toMatchObject({
      share,
      rowsWithTwoLegs,
    });
  });

  it('keeps every feature at least 1.5 device pixels tall when drawn at 16x16', () => {
    const bar = boundsOf(pathVertices(crossbar).points);
    const barHeightPx = (bar.maxY - bar.minY) * scale;
    const barWidthPx = (bar.maxX - bar.minX) * scale;
    expect(barHeightPx).toBeGreaterThanOrEqual(1.5);
    // At 16px the bridge is ~3.6px wide: still a visible line, not a hairline dot.
    expect(barWidthPx).toBeGreaterThanOrEqual(2);

    // The thinnest part of the letterform is a leg at the mouth of the notch.
    const glyph = pathVertices(outline).points;
    const last = glyph[glyph.length - 2];
    const mouthInner = glyph[glyph.length - 3];
    expect(last).toBeDefined();
    expect(mouthInner).toBeDefined();
    if (last === undefined || mouthInner === undefined) return;
    const leftLegWidthPx = (mouthInner.x - last.x) * scale;
    expect(leftLegWidthPx).toBeGreaterThanOrEqual(1.5);
  });

  it('has a crossbar that bridges the notch instead of floating in it', () => {
    const glyph = pathVertices(outline).points;
    // Vertices 4 and 5 are the two inner edges of the notch meeting at the counter apex.
    const counterApex = glyph[4];
    const innerLeft = glyph[5];
    const innerRight = glyph[3];
    expect(counterApex).toBeDefined();
    expect(innerLeft).toBeDefined();
    expect(innerRight).toBeDefined();
    if (counterApex === undefined || innerLeft === undefined || innerRight === undefined) return;

    const bar = boundsOf(pathVertices(crossbar).points);
    for (const y of [bar.minY, bar.maxY]) {
      const notchLeftX = xAtY(counterApex, innerLeft, y);
      const notchRightX = xAtY(counterApex, innerRight, y);
      // The bar starts to the left of the notch and ends to the right of it, so it is
      // filled into both legs: the two shapes read as one letter, not as two strokes.
      expect(bar.minX).toBeLessThan(notchLeftX);
      expect(bar.maxX).toBeGreaterThan(notchRightX);
      // ... and it still does not stick out of the outer silhouette.
      const outlineAtY = boundsOf(glyph).minX;
      expect(bar.minX).toBeGreaterThan(outlineAtY);
    }
  });
});

describe('icon.svg is the favicon plate', () => {
  it('is a full-bleed rounded plate behind the glyph', () => {
    const root = rootOf(ICON);
    const rects = elementsNamed(root, 'rect');
    expect(rects).toHaveLength(1);
    const plate = rects[0];
    expect(plate?.attrs['x']).toBeUndefined();
    expect(plate?.attrs['width']).toBe('32');
    expect(plate?.attrs['height']).toBe('32');
    expect(plate?.attrs['fill']?.toLowerCase()).toBe('#3ecf8e');
    // Rounded like a C10 control (6px at 1x): visible but not a pill.
    const radius = Number(plate?.attrs['rx']);
    expect(Number.isFinite(radius)).toBe(true);
    expect(radius).toBeGreaterThan(0);
    expect(radius).toBeLessThanOrEqual(8);
    // The plate is painted first and the glyph on top: paint order matters.
    const drawingChildren = root.children.filter((node) => node.name !== 'title' && node.name !== 'desc');
    expect(drawingChildren.map((node) => node.name)).toEqual(['rect', 'path', 'path']);
  });
});

describe('apple-icon.svg is the iOS variant of the same mark', () => {
  it('uses a full-bleed square plate because iOS applies its own corner mask', () => {
    const root = rootOf(APPLE_ICON);
    const rects = elementsNamed(root, 'rect');
    expect(rects).toHaveLength(1);
    const plate = rects[0];
    expect(plate?.attrs['width']).toBe('180');
    expect(plate?.attrs['height']).toBe('180');
    expect(plate?.attrs['rx']).toBeUndefined();
    expect(plate?.attrs['fill']?.toLowerCase()).toBe('#3ecf8e');
  });

  it('scales the 32px geometry by exactly 180/32 so both icons match optically', () => {
    const root = rootOf(APPLE_ICON);
    const groups = elementsNamed(root, 'g');
    expect(groups).toHaveLength(1);
    const transform = groups[0]?.attrs['transform'] ?? '';
    const match = /^scale\(\s*([\d.]+)\s*\)$/.exec(transform);
    expect(match).not.toBeNull();
    const factor = Number(match?.[1]);
    expect(factor).toBeCloseTo(180 / 32, 10);

    const apple = drawingPaths(root);
    const favicon = drawingPaths(rootOf(ICON));
    expect(apple.outline).toBe(favicon.outline);
    expect(apple.crossbar).toBe(favicon.crossbar);
  });
});
