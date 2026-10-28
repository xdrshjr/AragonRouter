import { createHash, randomBytes } from 'node:crypto';
import { timingSafeEqualString } from '@/lib/crypto';
import { execute, queryOne } from '@/lib/db';

/**
 * Self-drawn SVG captcha (WP1 · 图形验证码).
 *
 * Zero third-party dependencies: a compact 5x7 bitmap font is emitted as SVG
 * `<path>` data, so the answer never appears as selectable text (a `<text>` element
 * would hand it to any client verbatim). The image is of course derived from the
 * answer, so a captcha is an anti-automation speed bump, not a secret.
 *
 * A fingerprintable image would be worthless: with fixed glyph geometry a bot could
 * map every `d` string to its character once - from this file or from a handful of
 * labelled samples - and read each future answer straight out of the response. The
 * randomness therefore lives in the geometry itself: a per-challenge phase, a
 * per-glyph scale, random run splits and per-stroke jitter, all baked into the path
 * coordinates rather than into a `<g transform>` (which leaves `d` untouched). Two
 * challenges with the same answer share no `d` value; see
 * `tests/unit/user-core/captcha.test.ts`. Rotation, colour, noise dots and noise
 * lines add the visual noise on top.
 *
 * Lifecycle: 5 minute TTL, one-time consumption, at most {@link CAPTCHA_MAX_ATTEMPTS}
 * failed attempts before the challenge is burned.
 */

/** C-CAPTCHA: challenges live for five minutes. */
export const CAPTCHA_TTL_MS = 300_000;
/** C-CAPTCHA: wrong answers tolerated before the challenge is invalidated. */
export const CAPTCHA_MAX_ATTEMPTS = 5;
/** C-CAPTCHA: five glyphs per image. */
export const CAPTCHA_LENGTH = 5;

/**
 * Unambiguous alphabet: no `I`, `O`, `0`, `1`, `5`/`S` confusion is limited by
 * keeping the digit set small and the letter set free of look-alikes.
 */
export const CAPTCHA_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CANVAS_WIDTH = 168;
const CANVAS_HEIGHT = 56;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_SCALE = 5;
const GLYPH_ORIGIN_X = 14;
const GLYPH_STEP_X = 30;
const GLYPH_ORIGIN_Y = 8;

/** Per-glyph pixel size: 0.9x-1.1x of {@link GLYPH_SCALE}. */
const GLYPH_SCALE_MIN = 0.9;
const GLYPH_SCALE_SPAN = 0.2;
/** Per-glyph horizontal drift, in user units, on top of {@link GLYPH_STEP_X}. */
const GLYPH_DRIFT = 2;
/** Per-stroke drift, in user units: enough to kill a lookup table, not meant to blur. */
const STROKE_JITTER = 0.5;
/** Per-stroke stretch: 0.9x-1.1x of the nominal run length/thickness. */
const STROKE_SCALE_MIN = 0.9;
const STROKE_SCALE_SPAN = 0.2;
/** Visible gap left where an ink run was cut, so the pieces do not fuse back. */
const STROKE_GAP = 0.25;
/** A wide run is cut into at most this many pieces. */
const MAX_RUN_PIECES = 3;
/** Two decimals: short path data, plenty of entropy once every stroke draws its own. */
const COORD_DECIMALS = 2;
const COORD_FACTOR = 10 ** COORD_DECIMALS;

/** Palette values only (src/app/globals.css `:root`). */
const GLYPH_COLORS = ['#ededed', '#3ecf8e', '#4d9dff', '#f5a623'] as const;
const NOISE_COLORS = ['#2a2a2a', '#3a3a3a', '#8f8f8f', '#3ecf8e'] as const;

/** 5x7 bitmaps: `#` is ink, `.` is background. */
const GLYPHS: Record<string, readonly string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

export interface CreateCaptchaOptions {
  /**
   * Fixed answer, for tests only - the HTTP layer never passes it. The row stores
   * only a hash of this value, but the image is rendered from it (see the module
   * docstring), so the geometry still carries the answer.
   */
  answer?: string;
}

export interface CreatedCaptcha {
  id: string;
  svg: string;
  /** ISO timestamp; the challenge stops verifying after it. */
  expiresAt: string;
  /** Unix ms equivalent of `expiresAt`, for arithmetic in callers and tests. */
  expiresAtMs: number;
}

interface CaptchaRow {
  id: string;
  answer_hash: string;
  created_at: number;
  expires_at: number;
  attempts: number;
  consumed_at: number | null;
}

function randomInt(maxExclusive: number): number {
  // Rejection sampling keeps the distribution uniform for any alphabet size.
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  for (;;) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < limit) return value % maxExclusive;
  }
}

function randomAnswer(): string {
  let answer = '';
  for (let index = 0; index < CAPTCHA_LENGTH; index += 1) {
    answer += CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)];
  }
  return answer;
}

/** Normalize a submitted answer: trim + uppercase (answers are case-insensitive). */
export function normalizeCaptchaAnswer(answer: unknown): string | null {
  if (typeof answer !== 'string') return null;
  const normalized = answer.trim().toUpperCase();
  if (normalized.length === 0 || normalized.length > 16) return null;
  return normalized;
}

/**
 * The stored representation of an answer: an unsalted SHA-256 would let anyone
 * with a database dump test 32 five-character answers instantly, so the id is
 * mixed in as a per-challenge salt.
 */
export function hashCaptchaAnswer(id: string, answer: string): string {
  return createHash('sha256').update(`${id}:${answer}`, 'utf8').digest('hex');
}

/** Uniform `[0, 1)` value from the CSPRNG (no `Math.random` for anything security-adjacent). */
function randomFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/** Uniform value in `[min, min + span)`. */
function randomBetween(min: number, span: number): number {
  return min + randomFraction() * span;
}

/** Fixed two-decimal coordinate text: small SVG and comparable `d` strings. */
function formatCoord(value: number): string {
  return String(Math.round(value * COORD_FACTOR) / COORD_FACTOR);
}

interface GlyphLayout {
  /** Left edge of the glyph box, already shifted by the per-challenge phase. */
  originX: number;
  /** Pixel size of this glyph; randomized per challenge. */
  scale: number;
}

/**
 * Column ranges of one horizontal ink run. Wide runs are cut at random columns, so
 * the number and the boundaries of the emitted subpaths differ per challenge.
 */
function splitRun(runStart: number, runEnd: number): Array<[number, number]> {
  const width = runEnd - runStart;
  if (width < 2) return [[runStart, runEnd]];
  const pieceCount = width >= 3 ? 2 + randomInt(MAX_RUN_PIECES - 1) : 2;
  const cuts = new Set<number>();
  while (cuts.size < pieceCount - 1) {
    cuts.add(runStart + 1 + randomInt(width - 1));
  }
  const ordered = [...cuts].sort((left, right) => left - right);
  const ranges: Array<[number, number]> = [];
  let start = runStart;
  for (const cut of ordered) {
    ranges.push([start, cut]);
    start = cut;
  }
  ranges.push([start, runEnd]);
  return ranges;
}

/**
 * Emit one ink run as jittered rectangles.
 *
 * Every piece gets its own drift, length and thickness, and the whole glyph is
 * placed at a per-challenge phase. That randomness ends up in the path data, which
 * is what stops a `d` -> character lookup table from existing.
 */
function appendRunPieces(
  segments: string[],
  runStart: number,
  runEnd: number,
  row: number,
  layout: GlyphLayout,
): void {
  for (const [from, to] of splitRun(runStart, runEnd)) {
    const nominalWidth = (to - from) * layout.scale;
    const drawnWidth = Math.max(
      0.4,
      nominalWidth * randomBetween(STROKE_SCALE_MIN, STROKE_SCALE_SPAN) - STROKE_GAP,
    );
    const drawnHeight = layout.scale * randomBetween(STROKE_SCALE_MIN, STROKE_SCALE_SPAN);
    const x =
      layout.originX + from * layout.scale + randomBetween(-STROKE_JITTER, 2 * STROKE_JITTER);
    const y = row * layout.scale + randomBetween(-STROKE_JITTER, 2 * STROKE_JITTER);
    segments.push(
      `M${formatCoord(x)} ${formatCoord(y)}h${formatCoord(drawnWidth)}` +
        `v${formatCoord(drawnHeight)}h${formatCoord(-drawnWidth)}z`,
    );
  }
}

/** Build the per-glyph path data. Each ink run becomes one or more rectangles. */
function glyphPath(char: string, layout: GlyphLayout): string {
  const rows = GLYPHS[char];
  if (!rows) return '';
  const segments: string[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    const pixels = rows[row] ?? '';
    let runStart = -1;
    for (let column = 0; column <= pixels.length; column += 1) {
      const isInk = column < pixels.length && pixels[column] === '#';
      if (isInk && runStart < 0) runStart = column;
      if (!isInk && runStart >= 0) {
        appendRunPieces(segments, runStart, column, row, layout);
        runStart = -1;
      }
    }
  }
  return segments.join('');
}

/**
 * Draw one challenge image.
 *
 * The glyphs are rotated and vertically jittered inside a `<g>` transform for visual
 * noise, while the fingerprint-defeating randomness (phase, scale, run splits,
 * stroke jitter) is baked into the path coordinates themselves: a `<g>` transform
 * alone would leave every `d` value identical across challenges.
 */
export function renderCaptchaSvg(answer: string): string {
  // One phase for the whole challenge, shifted into the path coordinates.
  const phase = randomBetween(-GLYPH_DRIFT, 2 * GLYPH_DRIFT);
  const glyphNodes: string[] = [];
  for (let index = 0; index < answer.length; index += 1) {
    const char = answer[index] ?? '';
    const jitterY = randomInt(9) - 4;
    const rotation = randomInt(29) - 14;
    const color = GLYPH_COLORS[randomInt(GLYPH_COLORS.length)];
    const scale = GLYPH_SCALE * randomBetween(GLYPH_SCALE_MIN, GLYPH_SCALE_SPAN);
    const x =
      GLYPH_ORIGIN_X + index * GLYPH_STEP_X + randomBetween(-GLYPH_DRIFT, 2 * GLYPH_DRIFT);
    const y = GLYPH_ORIGIN_Y + jitterY;
    const glyph = glyphPath(char, { originX: phase, scale });
    const halfWidth = (GLYPH_WIDTH * scale) / 2;
    const halfHeight = (GLYPH_HEIGHT * scale) / 2;
    glyphNodes.push(
      '<g ' +
        `transform="translate(${formatCoord(x)} ${formatCoord(y)}) ` +
        `rotate(${rotation} ${formatCoord(halfWidth)} ${formatCoord(halfHeight)})">` +
        `<path d="${glyph}" fill="${color}"/></g>`,
    );
  }

  const noiseLines: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const x1 = randomInt(CANVAS_WIDTH);
    const y1 = randomInt(CANVAS_HEIGHT);
    const x2 = randomInt(CANVAS_WIDTH);
    const y2 = randomInt(CANVAS_HEIGHT);
    const color = NOISE_COLORS[randomInt(NOISE_COLORS.length)];
    noiseLines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
        `stroke="${color}" stroke-width="1" opacity="0.55"/>`,
    );
  }

  const noiseDots: string[] = [];
  for (let index = 0; index < 42; index += 1) {
    const cx = randomInt(CANVAS_WIDTH);
    const cy = randomInt(CANVAS_HEIGHT);
    const color = NOISE_COLORS[randomInt(NOISE_COLORS.length)];
    noiseDots.push(`<circle cx="${cx}" cy="${cy}" r="1" fill="${color}" opacity="0.5"/>`);
  }

  const background =
    `<rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" ` + 'fill="#1f1f1f" rx="6"/>';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" ` +
    `viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" role="img" aria-label="captcha">` +
    `${background}${noiseDots.join('')}${noiseLines.join('')}${glyphNodes.join('')}</svg>`
  );
}

/** Encode an SVG document the way `<img src>` and `fetch` both accept. */
export function captchaDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * Mint a challenge and persist it.
 *
 * Expired rows are pruned on the way in, which keeps the table bounded without a
 * background job.
 */
export function createCaptcha(
  now: number = Date.now(),
  options: CreateCaptchaOptions = {},
): CreatedCaptcha {
  const id = randomBytes(16).toString('hex');
  const answer = (options.answer ?? randomAnswer()).trim().toUpperCase();
  const expiresAt = now + CAPTCHA_TTL_MS;
  execute(
    'INSERT INTO captcha_challenges ' +
      '(id, answer_hash, created_at, expires_at, attempts, consumed_at) ' +
      'VALUES (?, ?, ?, ?, 0, NULL)',
    [id, hashCaptchaAnswer(id, answer), Math.trunc(now), Math.trunc(expiresAt)],
  );
  // Opportunistic pruning: anything that expired more than one TTL ago is dead.
  execute('DELETE FROM captcha_challenges WHERE expires_at < ?', [
    Math.trunc(now) - CAPTCHA_TTL_MS,
  ]);
  return {
    id,
    svg: renderCaptchaSvg(answer),
    expiresAt: new Date(expiresAt).toISOString(),
    expiresAtMs: expiresAt,
  };
}

/**
 * Verify a submitted answer.
 *
 * @returns `true` only for a live, unconsumed challenge with a matching answer;
 *   the challenge is consumed by the successful call (one-time).
 */
export function verifyCaptcha(id: unknown, answer: unknown, now: number = Date.now()): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  const normalized = normalizeCaptchaAnswer(answer);
  if (!normalized) return false;

  const row = queryOne<CaptchaRow>('SELECT * FROM captcha_challenges WHERE id = ?', [id]);
  if (!row) return false;
  if (row.consumed_at !== null) return false;
  if (Number(row.expires_at) <= now) return false;
  if (Number(row.attempts) >= CAPTCHA_MAX_ATTEMPTS) return false;

  if (!timingSafeEqualString(hashCaptchaAnswer(id, normalized), String(row.answer_hash))) {
    const result = execute(
      'UPDATE captcha_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL',
      [id],
    );
    if (result.changes > 0) {
      const attempts = Number(row.attempts) + 1;
      if (attempts >= CAPTCHA_MAX_ATTEMPTS) {
        execute(
          'UPDATE captcha_challenges SET consumed_at = ? ' +
            'WHERE id = ? AND consumed_at IS NULL',
          [Math.trunc(now), id],
        );
      }
    }
    return false;
  }

  // Conditional consume: two concurrent correct submissions cannot both win.
  const consumed = execute(
    'UPDATE captcha_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    [Math.trunc(now), id],
  );
  return consumed.changes > 0;
}

/** How many attempts are left; `0` for unknown, expired or burned challenges. */
export function remainingCaptchaAttempts(id: string, now: number = Date.now()): number {
  const row = queryOne<CaptchaRow>('SELECT * FROM captcha_challenges WHERE id = ?', [id]);
  if (!row || row.consumed_at !== null || Number(row.expires_at) <= now) return 0;
  return Math.max(0, CAPTCHA_MAX_ATTEMPTS - Number(row.attempts));
}
