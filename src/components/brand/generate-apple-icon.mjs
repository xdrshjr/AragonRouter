#!/usr/bin/env node
/**
 * Rasteriser for the AragonRouter iOS home-screen icon.
 *
 * Why this exists
 * ---------------
 * The App Router routes an iOS icon from `src/app/apple-icon.{jpg,jpeg,png}` only
 * (see `STATIC_METADATA_IMAGES.apple` in next/dist/lib/metadata/is-metadata-route.js:
 * SVG is *not* listed there, unlike `icon`). An `apple-icon.svg` therefore never
 * becomes a route, never reaches the browser and iOS keeps showing a blank tile.
 * iOS also has no SVG support for `apple-touch-icon`, so a PNG is the only artifact
 * that actually works.
 *
 * This script renders that PNG from the geometry of the vector master
 * (`src/app/apple-icon.svg`, 180x180, scale 180/32 = 5.625 over the 32x32 favicon
 * grid) using nothing but the Node standard library - no image dependency, no
 * canvas, no browser, no base64 blob checked in by hand.
 *
 * Honest limit: the path data below is *copied* from `src/app/icon.svg` /
 * `apple-icon.svg`, not parsed out of them, and `--check` only re-validates the PNG
 * in isolation. Editing the SVGs without editing these constants (or the reverse)
 * silently desynchronises the two, so keep them in one change and re-run the script.
 *
 * Output: 180x180, 8-bit truecolour (no alpha channel, per Apple's "no
 * transparency" guideline), full-bleed C10 `--brand` #3ecf8e plate with the
 * #121212 glyph on top.
 *
 * Usage:
 *   node src/components/brand/generate-apple-icon.mjs            # write + verify
 *   node src/components/brand/generate-apple-icon.mjs --check    # verify only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

/** Edge length of the iOS icon, in pixels. */
const SIZE = 180;
/** The glyph geometry is authored on the 32x32 favicon grid, exactly like icon.svg. */
const GRID = 32;
const SCALE = SIZE / GRID;

/** C10 tokens only: plate = `--brand` #3ecf8e, glyph = `--bg` #121212. */
const PLATE = [0x3e, 0xcf, 0x8e];
const GLYPH = [0x12, 0x12, 0x12];

/** Truncated-apex "A" outline from `src/app/icon.svg` (same numbers, same order). */
const GLYPH_POLYGON = [
  [14.1, 6],
  [17.9, 6],
  [26, 25.8],
  [21.4, 25.8],
  [16, 12.6],
  [10.6, 25.8],
  [6, 25.8],
];

/** Bridging crossbar from `src/app/icon.svg`. */
const CROSSBAR = { x0: 12.4, y0: 17.4, x1: 19.6, y1: 20.8 };

/** Supersampling grid per axis: 4x4 = 16 coverage samples per pixel (anti-aliasing). */
const SUBSAMPLES = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(HERE, '../../app/apple-icon.png');

/**
 * Even-odd ray casting. Returns true when (x, y) lies inside the polygon.
 * Vertices are expected in the 32x32 glyph grid.
 */
function inPolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[previous];
    const straddles = y1 > y !== y2 > y;
    if (straddles && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

/** Coverage in [0, 1] of the glyph for the pixel at column px / row py. */
function glyphCoverage(px, py) {
  let hits = 0;
  for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
    // Sample the centre of each sub-cell, mapped back onto the 32-unit glyph grid.
    const gy = (py + (sy + 0.5) / SUBSAMPLES) / SCALE;
    for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
      const gx = (px + (sx + 0.5) / SUBSAMPLES) / SCALE;
      const inGlyph =
        inPolygon(gx, gy, GLYPH_POLYGON) ||
        (gx >= CROSSBAR.x0 && gx <= CROSSBAR.x1 && gy >= CROSSBAR.y0 && gy <= CROSSBAR.y1);
      if (inGlyph) hits += 1;
    }
  }
  return hits / (SUBSAMPLES * SUBSAMPLES);
}

/** Raw PNG scanlines: one filter byte (0 = None) followed by RGB triplets. */
function renderScanlines() {
  const stride = SIZE * 3;
  const raw = Buffer.alloc(SIZE * (stride + 1));
  for (let y = 0; y < SIZE; y += 1) {
    let cursor = y * (stride + 1);
    raw[cursor] = 0;
    cursor += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const coverage = glyphCoverage(x, y);
      for (let channel = 0; channel < 3; channel += 1) {
        raw[cursor] = Math.round(PLATE[channel] + (GLYPH[channel] - PLATE[channel]) * coverage);
        cursor += 1;
      }
    }
  }
  return raw;
}

/** CRC-32 (PNG polynomial 0xEDB88320), table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a PNG chunk: length, 4-char type, payload, CRC over type+payload. */
function chunk(type, payload) {
  const typeAndPayload = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const out = Buffer.alloc(typeAndPayload.length + 8);
  out.writeUInt32BE(payload.length, 0);
  typeAndPayload.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndPayload), typeAndPayload.length + 4);
  return out;
}

/** Encodes the RGBA-free scanlines into a complete PNG file. */
function encodePng(raw) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); // width
  ihdr.writeUInt32BE(SIZE, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB (opaque, no alpha channel)
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decodes a PNG we just produced and asserts the properties the acceptance checks
 * care about: valid signature, 180x180 RGB, plate colour at the corners, glyph
 * colour under the "A" and no transparency. Throws on the first mismatch so a
 * broken asset can never be committed silently.
 */
function verify(png) {
  const expectedSignature = '89504e470d0a1a0a';
  const signature = png.subarray(0, 8).toString('hex');
  if (signature !== expectedSignature) {
    throw new Error(`bad PNG signature: ${signature}`);
  }

  let offset = 8;
  let seenHeader = false;
  const idat = [];
  let sawEnd = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== stored) {
      throw new Error(`bad CRC in ${type} chunk`);
    }
    if (type === 'IHDR') {
      seenHeader = true;
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (width !== SIZE || height !== SIZE) {
        throw new Error(`expected ${SIZE}x${SIZE}, got ${width}x${height}`);
      }
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) {
        throw new Error(`unexpected IHDR: depth=${data[8]} colour=${data[9]} interlace=${data[12]}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
    }
    offset += 12 + length;
  }
  if (!seenHeader) throw new Error('missing IHDR');
  if (idat.length === 0) throw new Error('missing IDAT');
  if (!sawEnd) throw new Error('missing IEND');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = SIZE * 3 + 1;
  if (raw.length !== stride * SIZE) {
    throw new Error(`unexpected scanline length ${raw.length}, expected ${stride * SIZE}`);
  }
  const pixel = (x, y) => {
    const at = y * stride + 1 + x * 3;
    return [raw[at], raw[at + 1], raw[at + 2]];
  };
  const expectPixel = (x, y, expected, label) => {
    const actual = pixel(x, y);
    if (actual.join(',') !== expected.join(',')) {
      throw new Error(`${label} at (${x},${y}): expected rgb(${expected}) got rgb(${actual})`);
    }
  };
  // Corners are plate, the middle of the "A" bowl is glyph, and the crossbar is glyph.
  expectPixel(0, 0, PLATE, 'top-left plate');
  expectPixel(SIZE - 1, SIZE - 1, PLATE, 'bottom-right plate');
  expectPixel(Math.round(16 * SCALE), Math.round(19.1 * SCALE), GLYPH, 'crossbar');
  expectPixel(Math.round(16 * SCALE), Math.round(8 * SCALE), GLYPH, 'apex');

  return { bytes: png.length, samples: raw.length };
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  const stats = verify(readFileSync(TARGET));
  process.stdout.write(`OK ${TARGET} is a valid ${SIZE}x${SIZE} PNG (${stats.bytes} bytes)\n`);
} else {
  const raw = renderScanlines();
  const png = encodePng(raw);
  const stats = verify(png);
  writeFileSync(TARGET, png);
  process.stdout.write(
    `wrote ${TARGET} ${SIZE}x${SIZE} rgb, ${stats.bytes} bytes (idat raw ${stats.samples} bytes)\n`,
  );
}
