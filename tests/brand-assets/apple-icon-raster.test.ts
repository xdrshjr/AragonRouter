/**
 * The raster half of the iOS icon: `src/app/apple-icon.png` vs its vector master
 * `src/app/apple-icon.svg` vs the generator that produced it.
 *
 * Why this suite exists
 * ---------------------
 * Next 15 only routes `apple-icon.{jpg,jpeg,png}` for the iOS tile, so the file the
 * browser (and iOS) actually receives is the *PNG*, not the SVG. The generator
 * (`src/components/brand/generate-apple-icon.mjs`) duplicates the path coordinates as
 * constants and, as its own header states, "`--check` only re-validates the PNG in
 * isolation" - nothing proved that the committed PNG still draws the committed vector.
 * A silent desync would ship an iOS icon that no longer matches the favicon, and no
 * other test in the repository would notice.
 *
 * What is proven here
 * -------------------
 *  1. the committed PNG is a structurally valid, opaque 180x180 RGB PNG (chunk CRCs,
 *     IHDR, IEND) - not a placeholder or a re-encoded screenshot;
 *  2. every one of its 32 400 pixels is either the `--brand` plate, the `--bg` glyph or
 *     an anti-aliased blend *between exactly those two tokens* - no third colour;
 *  3. the pixel coverage matches, pixel for pixel, a 4x4 supersampled raster of the
 *     **SVG path data** (path <-> bitmap, both read from disk);
 *  4. the generator's duplicated constants equal the SVG geometry, so editing one
 *     without the other fails here instead of shipping;
 *  5. the build serves that exact byte sequence as `image/png` and links it as the
 *     180x180 `apple-touch-icon` - asset <-> build output.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  boundsOf,
  elementsNamed,
  parseSvg,
  pathVertices,
  pointInPolygon,
  PROJECT_ROOT,
  read,
  type Point,
} from './support/svg';

const ICON = 'src/app/icon.svg';
const APPLE_ICON = 'src/app/apple-icon.svg';
const APPLE_PNG = 'src/app/apple-icon.png';
const GENERATOR = 'src/components/brand/generate-apple-icon.mjs';

const SIZE = 180;
/** The glyph grid both SVG assets are authored on. */
const GRID = 32;
const SCALE = SIZE / GRID;

/** C10 tokens: `--brand` #3ecf8e plate, `--bg` #121212 glyph. */
const PLATE = [0x3e, 0xcf, 0x8e] as const;
const GLYPH = [0x12, 0x12, 0x12] as const;

const SUPERSAMPLES = 4;

// --- PNG decoding (no dependency: zlib + CRC32 are standard library) ----------------

const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface PngImage {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
  /** `[x, y] -> [r, g, b]` for a decoded, unfiltered truecolour image. */
  pixel(x: number, y: number): [number, number, number];
  chunkTypes: string[];
  byteLength: number;
}

/** Throws on anything that is not a well-formed, non-interlaced truecolour PNG. */
function decodePng(bytes: Buffer): PngImage {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  let offset = 8;
  let header: { width: number; height: number; bitDepth: number; colourType: number; interlace: number } | undefined;
  const idat: Buffer[] = [];
  const chunkTypes: string[] = [];
  let sawEnd = false;

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const stored = bytes.readUInt32BE(offset + 8 + length);
    expect(crc32(bytes.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`).toBe(stored);
    chunkTypes.push(type);

    if (type === 'IHDR') {
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        bitDepth: payload[8] ?? -1,
        colourType: payload[9] ?? -1,
        interlace: payload[12] ?? -1,
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(payload));
    } else if (type === 'IEND') {
      sawEnd = true;
    }
    offset += 12 + length;
  }

  expect(sawEnd).toBe(true);
  expect(header).toBeDefined();
  if (header === undefined) throw new Error('PNG has no IHDR');
  expect(idat.length).toBeGreaterThan(0);

  // Colour type 2 = truecolour, no alpha: Apple's home-screen icons must be opaque.
  expect(header.colourType).toBe(2);
  expect(header.bitDepth).toBe(8);
  expect(header.interlace).toBe(0);

  const { width, height } = header;
  const bytesPerPixel = 3;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((stride + 1) * height);

  // Un-filter the scanlines (all five PNG filter types, so a future encoder change to
  // adaptive filtering keeps working instead of producing garbage pixels).
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bytesPerPixel ? (out[i - bytesPerPixel] ?? 0) : 0;
      const up = prior?.[i] ?? 0;
      const upLeft = i >= bytesPerPixel ? (prior?.[i - bytesPerPixel] ?? 0) : 0;
      const value = line[i] ?? 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + Math.floor((left + up) / 2);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          restored = value + predictor;
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${String(filter)} on row ${y}`);
      }
      out[i] = restored & 0xff;
    }
  }

  return {
    width,
    height,
    bitDepth: header.bitDepth,
    colourType: header.colourType,
    interlace: header.interlace,
    chunkTypes,
    byteLength: bytes.length,
    pixel(x: number, y: number): [number, number, number] {
      const at = y * stride + x * bytesPerPixel;
      return [pixels[at] ?? -1, pixels[at + 1] ?? -1, pixels[at + 2] ?? -1];
    },
  };
}

// --- expected coverage, computed from the SVG (not from the generator) ---------------

interface Glyph {
  outline: readonly Point[];
  crossbar: { x0: number; y0: number; x1: number; y1: number };
}

/** The glyph of `apple-icon.svg`, read from its path data on the 32-unit grid. */
function svgGlyph(): Glyph {
  const root = parseSvg(read(APPLE_ICON));
  const paths = elementsNamed(root, 'path').map((node) => node.attrs['d'] ?? '');
  expect(paths).toHaveLength(2);
  const outline = pathVertices(paths[0] ?? '').points;
  const bar = boundsOf(pathVertices(paths[1] ?? '').points);
  return { outline, crossbar: { x0: bar.minX, y0: bar.minY, x1: bar.maxX, y1: bar.maxY } };
}

function insideGlyph(x: number, y: number, glyph: Glyph): boolean {
  if (pointInPolygon(x, y, glyph.outline)) return true;
  const { x0, y0, x1, y1 } = glyph.crossbar;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** Coverage in [0, 1] of the glyph for one raster pixel, 4x4 sub-samples. */
function expectedCoverage(px: number, py: number, glyph: Glyph): number {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLES; sy += 1) {
    const gy = (py + (sy + 0.5) / SUPERSAMPLES) / SCALE;
    for (let sx = 0; sx < SUPERSAMPLES; sx += 1) {
      const gx = (px + (sx + 0.5) / SUPERSAMPLES) / SCALE;
      if (insideGlyph(gx, gy, glyph)) hits += 1;
    }
  }
  return hits / (SUPERSAMPLES * SUPERSAMPLES);
}

/** Coverage encoded in a pixel: 0 = plate, 1 = glyph (read off the red channel). */
function observedCoverage(rgb: readonly [number, number, number]): number {
  return (PLATE[0] - rgb[0]) / (PLATE[0] - GLYPH[0]);
}

// --- the asset itself ---------------------------------------------------------------

const pngBytes = readFileSync(join(PROJECT_ROOT, APPLE_PNG));
const png = decodePng(pngBytes);
const glyph = svgGlyph();

describe('src/app/apple-icon.png is a real, opaque 180x180 iOS tile', () => {
  it('has a valid chunk stream', () => {
    expect(png.width).toBe(SIZE);
    expect(png.height).toBe(SIZE);
    expect(png.chunkTypes[0]).toBe('IHDR');
    expect(png.chunkTypes).toContain('IDAT');
    expect(png.chunkTypes[png.chunkTypes.length - 1]).toBe('IEND');
    // Small enough to be a flat vector raster, not a photo-derived placeholder.
    expect(png.byteLength).toBeGreaterThan(200);
    expect(png.byteLength).toBeLessThan(20_000);
  });

  it('paints the plate at the corners and the glyph under the "A"', () => {
    for (const [x, y] of [
      [0, 0],
      [SIZE - 1, 0],
      [0, SIZE - 1],
      [SIZE - 1, SIZE - 1],
    ] as const) {
      expect(png.pixel(x, y), `corner (${x},${y})`).toEqual([...PLATE]);
    }
    // Full-bleed: iOS applies its own corner mask, so there is no transparent margin.
    expect(png.pixel(0, 0)).toEqual([...PLATE]);
    // The apex (top of the truncated "A") and the crossbar are glyph-dark.
    expect(png.pixel(Math.round(16 * SCALE), Math.round(8 * SCALE))).toEqual([...GLYPH]);
    expect(png.pixel(Math.round(16 * SCALE), Math.round(19.1 * SCALE))).toEqual([...GLYPH]);
  });

  it('uses no colour other than the brand/glyph ramp', () => {
    const offenders: string[] = [];
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const rgb = png.pixel(x, y);
        for (let channel = 0; channel < 3; channel += 1) {
          const plate = PLATE[channel] ?? 0;
          const glyphChannel = GLYPH[channel] ?? 0;
          const low = Math.min(plate, glyphChannel);
          const high = Math.max(plate, glyphChannel);
          // Anti-aliasing may only interpolate the two tokens channel by channel.
          if ((rgb[channel] ?? -1) < low || (rgb[channel] ?? -1) > high) offenders.push(`${x},${y}`);
        }
        const [r, g, b] = rgb;
        // Every channel must sit at the same point of the ramp (a neutral grey, not a hue).
        const spread = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
        const expectedSpread = Math.abs(PLATE[0] - PLATE[1]) * (1 - observedCoverage(rgb));
        if (spread - expectedSpread > 1.5) offenders.push(`hue@${x},${y}`);
      }
    }
    expect(offenders.slice(0, 10)).toEqual([]);
  });
});

describe('the PNG still draws the SVG vector master', () => {
  it('matches the SVG coverage pixel for pixel', () => {
    let worst = { x: 0, y: 0, delta: 0 };
    let total = 0;
    let painted = 0;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const expected = expectedCoverage(x, y, glyph);
        const observed = observedCoverage(png.pixel(x, y));
        const delta = Math.abs(expected - observed);
        total += delta;
        if (expected > 0) painted += 1;
        if (delta > worst.delta) worst = { x, y, delta };
      }
    }
    const mean = total / (SIZE * SIZE);
    // 1/16 coverage steps plus 8-bit rounding: a real desync (wrong path, wrong scale,
    // wrong translate) moves whole regions, not single pixels.
    expect(worst.delta).toBeLessThan(0.09);
    expect(mean).toBeLessThan(0.002);
    // Sanity: the glyph is neither invisible nor a full-bleed blob.
    const share = painted / (SIZE * SIZE);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.5);
  });

  it('keeps the same geometry as the 32px favicon', () => {
    const favicon = parseSvg(read(ICON));
    const apple = parseSvg(read(APPLE_ICON));
    const d = (root: ReturnType<typeof parseSvg>) =>
      elementsNamed(root, 'path').map((node) => node.attrs['d'] ?? '');
    expect(d(apple)).toEqual(d(favicon));
    // The 180px asset is the same 32-unit artwork scaled by exactly 180/32.
    const group = elementsNamed(apple, 'g')[0];
    expect(group?.attrs['transform']).toBe(`scale(${SCALE})`);
  });
});

describe('the generator script and the assets stay in sync', () => {
  const script = read(GENERATOR);

  it('duplicates the favicon path coordinates exactly', () => {
    const polygon = /const GLYPH_POLYGON = \[([\s\S]*?)\];/.exec(script)?.[1] ?? '';
    const scripted = [...polygon.matchAll(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
    }));
    const favicon = pathVertices(elementsNamed(parseSvg(read(ICON)), 'path')[0]?.attrs['d'] ?? '').points;
    expect(scripted).toHaveLength(favicon.length);
    expect(scripted).toEqual(favicon);

    const crossbar = /const CROSSBAR = \{([^}]*)\}/.exec(script)?.[1] ?? '';
    const constant = (name: string) => Number(new RegExp(`${name}:\\s*(-?[\\d.]+)`).exec(crossbar)?.[1]);
    const bar = boundsOf(pathVertices(elementsNamed(parseSvg(read(ICON)), 'path')[1]?.attrs['d'] ?? '').points);
    expect([constant('x0'), constant('y0'), constant('x1'), constant('y1')]).toEqual([
      bar.minX,
      bar.minY,
      bar.maxX,
      bar.maxY,
    ]);
  });

  it('declares the C10 token colours and no other paint', () => {
    expect(script).toMatch(/const PLATE = \[0x3e, 0xcf, 0x8e\];/);
    expect(script).toMatch(/const GLYPH = \[0x12, 0x12, 0x12\];/);
    expect(script).not.toMatch(/https?:\/\//);
  });

  it('passes its own --check mode against the committed PNG', () => {
    const stdout = execFileSync(process.execPath, [join(PROJECT_ROOT, GENERATOR), '--check'], {
      encoding: 'utf8',
    });
    expect(stdout).toContain('valid 180x180 PNG');
  });
});

// --- build output (guarded: the assertions need a production build) -----------------

const NEXT_DIR = join(PROJECT_ROOT, '.next');
const HAS_BUILD = existsSync(join(NEXT_DIR, 'server', 'app', 'apple-icon.png.body'));

describe.skipIf(!HAS_BUILD)('the build serves exactly this PNG as the iOS tile', () => {
  it('serves the committed bytes as image/png', () => {
    const served = readFileSync(join(NEXT_DIR, 'server', 'app', 'apple-icon.png.body'));
    expect(served.equals(pngBytes)).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(NEXT_DIR, 'server', 'app', 'apple-icon.png.meta'), 'utf8'),
    ) as { status: number; headers: Record<string, string> };
    expect(meta.status).toBe(200);
    expect(meta.headers['content-type']).toBe('image/png');
    expect(meta.headers['cache-control']).toContain('immutable');
  });

  it('links it as the 180x180 apple-touch-icon next to the file-convention favicon', () => {
    const html = readFileSync(join(NEXT_DIR, 'server', 'app', '_not-found.html'), 'utf8');
    const apple = [...html.matchAll(/<link[^>]*rel="apple-touch-icon"[^>]*>/g)].map((match) => match[0]);
    expect(apple).toHaveLength(1);
    const tag = apple[0] ?? '';
    expect(tag).toContain('/apple-icon.png?');
    expect(tag).toContain('sizes="180x180"');
    expect(tag).toContain('type="image/png"');
    // The routed favicon is still there - adding the tile must not replace it.
    expect(html).toMatch(/<link[^>]*rel="icon"[^>]*\/icon\.svg\?[0-9a-f]+/);
    // iOS standalone hints survived the metadata change.
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('apple-mobile-web-app-title" content="AragonRouter"');
    // Nothing links the un-routed apple SVG (it would 404 on the home screen).
    expect(html).not.toContain('apple-icon.svg');
  });
});
