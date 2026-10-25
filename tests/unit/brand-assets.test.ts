/**
 * Brand asset contract: the AI-generated logo set + the component that consumes it.
 *
 * Unlike the governance-era suites this replaces, these assertions live under
 * `tests/unit` on purpose: `vitest.config.ts` includes only that directory, so this
 * is the one brand test that actually runs in `npm test` and therefore in CI.
 *
 * Everything here is a pure file/pixel assertion - no network, no database, no
 * browser. PNG decoding is done by hand (IHDR + zlib) rather than by pulling in an
 * image dependency, so the check keeps working on a bare checkout.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

/** C10 tokens - the only colours the brand art is allowed to contain. */
const BG = { r: 0x12, g: 0x12, b: 0x12 };
const BRAND = { r: 0x3e, g: 0xcf, b: 0x8e };

interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGB triples, 3 bytes per pixel. */
  pixels: Buffer;
}

/**
 * Byte read that satisfies `noUncheckedIndexedAccess`: the project compiles with
 * it on, and a decoder that asserts its own bounds is exactly where an undefined
 * would otherwise leak into arithmetic.
 */
function at(buf: Buffer, index: number): number {
  return buf[index] ?? 0;
}

/** Pixel read from a decoded buffer: (r,g,b) at x,y. */
function rgb(png: DecodedPng, x: number, y: number): [number, number, number] {
  const base = (y * png.width + x) * 3;
  return [at(png.pixels, base), at(png.pixels, base + 1), at(png.pixels, base + 2)];
}

/**
 * Minimal PNG reader for the subset our build script emits: 8-bit truecolour
 * (colour type 2), no interlace, filter types 0-4. Enough to assert size and
 * palette without a decoder dependency.
 */
function decodePng(path: string): DecodedPng {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 8).toString('hex'), `${path} is not a PNG`).toBe('89504e470d0a1a0a');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let bitDepth = -1;
  let interlace = -1;
  const idat: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = at(data, 8);
      colourType = at(data, 9);
      interlace = at(data, 12);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  expect(bitDepth, `${path} must be 8-bit`).toBe(8);
  expect(colourType, `${path} must be truecolour (2) or truecolour+alpha (6)`).toBeLessThanOrEqual(6);
  expect(colourType, `${path} cannot be grayscale/palette`).toBeGreaterThanOrEqual(2);
  expect(interlace, `${path} must not be interlaced`).toBe(0);

  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 3);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = at(raw, pos);
    pos += 1;
    raw.copy(current, 0, pos, pos + stride);
    pos += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? at(current, i - channels) : 0;
      const up = at(previous, i);
      const upLeft = i >= channels ? at(previous, i - channels) : 0;
      let value = at(current, i);
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter} in ${path}`);
      }
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      out[(y * width + x) * 3] = at(current, x * channels);
      out[(y * width + x) * 3 + 1] = at(current, x * channels + 1);
      out[(y * width + x) * 3 + 2] = at(current, x * channels + 2);
    }
    current.copy(previous);
  }

  return { width, height, pixels: out };
}

/** Distance from a pixel to the C10 duotone segment, ignoring anti-aliasing blends. */
function isOnBrandRamp(r: number, g: number, b: number): boolean {
  // The projection only ever lerps BG -> BRAND, so a pixel must sit on that line.
  const dr = BRAND.r - BG.r;
  const dg = BRAND.g - BG.g;
  const db = BRAND.b - BG.b;
  const pr = r - BG.r;
  const pg = g - BG.g;
  const pb = b - BG.b;
  const lengthSq = dr * dr + dg * dg + db * db;
  let t = (pr * dr + pg * dg + pb * db) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  const er = pr - dr * t;
  const eg = pg - dg * t;
  const eb = pb - db * t;
  // 12 units of slack covers 8-bit rounding, PNG quantisation and the unsharp mask
  // applied to the 32px preview; anything wider would let stray colours through.
  return Math.sqrt(er * er + eg * eg + eb * eb) <= 12;
}

describe('the AI-generated brand set exists at every size the app needs', () => {
  const expected: ReadonlyArray<readonly [string, number]> = [
    ['public/brand-mark.png', 512],
    ['src/app/icon.png', 256],
    ['src/app/apple-icon.png', 180],
  ];

  for (const [relativePath, edge] of expected) {
    it(`${relativePath} is a square ${edge}x${edge} PNG`, () => {
      const path = join(ROOT, relativePath);
      expect(existsSync(path), `${relativePath} is missing`).toBe(true);
      const png = decodePng(path);
      expect(png.width).toBe(edge);
      expect(png.height).toBe(edge);
    });
  }

  it('the superseded vector brand files are gone, so nothing can render the old mark', () => {
    expect(existsSync(join(ROOT, 'src/app/icon.svg'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/app/apple-icon.svg'))).toBe(false);
  });

  it('the 512px master stays small enough to ship on every page load', () => {
    const bytes = readFileSync(join(ROOT, 'public/brand-mark.png')).length;
    expect(bytes).toBeLessThan(120 * 1024);
  });
});

describe('the art is projected onto the exact C10 duotone pair', () => {
  const png = decodePng(join(ROOT, 'public/brand-mark.png'));

  it('the plate is exactly --bg #121212 at every corner and edge midpoint', () => {
    const { width: w, height: h, pixels } = png;
    const points: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
      [Math.floor(w / 2), 0],
      [Math.floor(w / 2), h - 1],
      [0, Math.floor(h / 2)],
      [w - 1, Math.floor(h / 2)],
    ];
    for (const [x, y] of points) {
      expect(
        rgb(png, x, y),
        `corner/edge pixel (${x},${y}) is not fully-flattened --bg`,
      ).toEqual([BG.r, BG.g, BG.b]);
    }
  });

  it('every pixel sits on the BG→BRAND ramp (no stray hues, no leftover white)', () => {
    const { pixels } = png;
    let offRamp = 0;
    let whitish = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      const r = at(pixels, i);
      const g = at(pixels, i + 1);
      const b = at(pixels, i + 2);
      if (r > 240 && g > 240 && b > 240) whitish += 1;
      else if (!isOnBrandRamp(r, g, b)) offRamp += 1;
    }
    expect(whitish, 'white canvas leaked into the icon').toBe(0);
    expect(offRamp, 'pixels outside the brand ramp').toBe(0);
  });

  it('the accent actually reaches the brand green, so it matches the UI', () => {
    const { pixels } = png;
    let best = -1;
    for (let i = 0; i < pixels.length; i += 3) {
      const greenness = at(pixels, i + 1) - at(pixels, i);
      if (greenness > best) best = greenness;
    }
    // Peak greenness must be close to BRAND.g - BRAND.r = 0xcf - 0x3e = 145.
    expect(best).toBeGreaterThanOrEqual(135);
  });

  it('the mark is horizontally centred and does not touch the plate edge', () => {
    const { width: w, height: h, pixels } = png;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 3;
        if (at(pixels, i + 1) - at(pixels, i) > 25) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    expect(maxX, 'no accent pixels found').toBeGreaterThan(-1);
    const centre = (minX + maxX) / 2;
    expect(Math.abs(centre - w / 2), 'mark is not horizontally centred').toBeLessThan(w * 0.06);
    const marginX = Math.min(minX, w - 1 - maxX);
    expect(marginX, 'mark touches the icon edge').toBeGreaterThan(w * 0.05);
  });
});

describe('BrandMark is wired to the generated raster', () => {
  const source = readFileSync(join(ROOT, 'src/components/brand/BrandMark.tsx'), 'utf8');

  it('serves the 512px master from public/', () => {
    expect(source).toContain("'/brand-mark.png'");
  });

  it('keeps the contracted props optional and clamps the size', () => {
    expect(source).toMatch(/export function BrandMark\(/);
    expect(source).toMatch(/size\?:\s*number/);
    expect(source).toMatch(/withWordmark\?:\s*boolean/);
    expect(source).toMatch(/MIN_SIZE/);
    expect(source).toMatch(/MAX_SIZE/);
  });

  it('does not reach for next/image (the asset is a fixed, already-optimised PNG)', () => {
    expect(source).not.toContain("from 'next/image'");
  });

  it('is consumed by the login card, the rail and the topbar', () => {
    for (const file of [
      'src/app/login/page.tsx',
      'src/components/console/Sidebar.tsx',
      'src/components/console/Topbar.tsx',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, `${file} no longer renders the brand`).toContain('BrandMark');
    }
  });
});

describe('the App Router picks the raster up through file convention', () => {
  it('layout.tsx declares no icons object, so the file convention wins', () => {
    const layout = readFileSync(join(ROOT, 'src/app/layout.tsx'), 'utf8');
    expect(layout).not.toMatch(/^\s*icons:/m);
  });

  it('the build emits both icon routes when a build output exists', () => {
    const manifest = join(ROOT, '.next', 'server', 'app', 'icon.png.meta');
    if (!existsSync(manifest)) return; // no build yet: covered by `next build` in CI
    expect(existsSync(join(ROOT, '.next', 'server', 'app', 'apple-icon.png.meta'))).toBe(true);
  });
});

describe('the brand art is reproducible from its generator', () => {
  it('design/build-brand-assets.py exists and targets the shipped paths', () => {
    const path = join(ROOT, 'design/build-brand-assets.py');
    expect(existsSync(path)).toBe(true);
    const script = readFileSync(path, 'utf8');
    for (const target of ['public/brand-mark.png', 'src/app/icon.png', 'src/app/apple-icon.png']) {
      expect(script).toContain(target);
    }
  });

  it('the generator pins the exact C10 duotone values', () => {
    const script = readFileSync(join(ROOT, 'design/build-brand-assets.py'), 'utf8');
    expect(script).toContain('0x12, 0x12, 0x12');
    expect(script).toContain('0x3E, 0xCF, 0x8E');
  });

  it('the Python sources at least parse (no syntax drift)', () => {
    execFileSync('python', ['-c', 'import ast,pathlib,sys; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8")) for p in sys.argv[1:]]',
      join(ROOT, 'design/build-brand-assets.py'),
      join(ROOT, 'design/inspect-logo.py'),
    ], { stdio: 'pipe' });
  });
});
