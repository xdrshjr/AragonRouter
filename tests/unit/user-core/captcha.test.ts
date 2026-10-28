import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAPTCHA_ALPHABET,
  CAPTCHA_LENGTH,
  CAPTCHA_MAX_ATTEMPTS,
  CAPTCHA_TTL_MS,
  captchaDataUrl,
  createCaptcha,
  hashCaptchaAnswer,
  normalizeCaptchaAnswer,
  remainingCaptchaAttempts,
  renderCaptchaSvg,
  verifyCaptcha,
} from '@/lib/captcha';
import { execute, queryOne } from '@/lib/db';
import { prepareTestEnv } from '../test-helpers';

/**
 * C-CAPTCHA: a self-drawn SVG challenge with a 5 minute TTL, one-time consumption
 * and at most five attempts.
 *
 * The answer is only ever stored as a hash and never appears as text, but the image
 * is drawn from it - so the tests create challenges with an explicit answer (the
 * option the HTTP layer never passes) instead of OCR-ing the SVG.
 */

const NOW = 1_700_000_000_000;

beforeEach(() => {
  prepareTestEnv();
});

function decode(dataUrl: string): string {
  const prefix = 'data:image/svg+xml;base64,';
  expect(dataUrl.startsWith(prefix)).toBe(true);
  return Buffer.from(dataUrl.slice(prefix.length), 'base64').toString('utf8');
}

describe('captcha: image generation (C-CAPTCHA)', () => {
  it('exposes the documented constants', () => {
    expect(CAPTCHA_TTL_MS).toBe(300_000);
    expect(CAPTCHA_MAX_ATTEMPTS).toBe(5);
    expect(CAPTCHA_LENGTH).toBe(5);
    expect(CAPTCHA_ALPHABET).not.toMatch(/[IO01]/);
  });

  it('mints a challenge with an id, an SVG data URL and a five minute expiry', () => {
    const created = createCaptcha(NOW);
    expect(created.id).toMatch(/^[0-9a-f]{32}$/);
    expect(created.expiresAt).toBe(new Date(NOW + CAPTCHA_TTL_MS).toISOString());
    expect(created.expiresAtMs).toBe(NOW + CAPTCHA_TTL_MS);

    const svg = decode(captchaDataUrl(created.svg));
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // Noise: dots and lines, no external references (a captcha must not phone home).
    expect(svg).toMatch(/<circle /);
    expect(svg).toMatch(/<line /);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('draws glyphs as vector paths, never as <text>', () => {
    const answer = 'ABCDE';
    const created = createCaptcha(NOW, { answer });
    const svg = decode(captchaDataUrl(created.svg));
    expect(svg).toContain('<path');
    expect(svg).not.toContain('>ABCDE<');
    expect(svg).not.toMatch(new RegExp(`>${answer}`));
    expect(svg).not.toContain('<text');
  });

  it('randomizes the emitted geometry, so a d -> character table cannot be built', () => {
    const collectPaths = (): Set<string> => {
      const svg = decode(captchaDataUrl(createCaptcha(NOW, { answer: 'ABCDE' }).svg));
      return new Set([...svg.matchAll(/d="([^"]+)"/g)].map((match) => match[1] ?? ''));
    };

    const first = collectPaths();
    const second = collectPaths();
    // One <path> per glyph of the five character answer.
    expect(first.size).toBe(5);
    expect(second.size).toBe(5);
    // Same fixed answer, two challenges: not one path may be reused verbatim, which
    // is what would let a client read the answer out of the response body.
    const reused = [...first].filter((path) => second.has(path));
    expect(reused).toEqual([]);
  });

  it('only uses palette colours', () => {
    const svg = decode(captchaDataUrl(createCaptcha(NOW).svg));
    const palette = new Set(['#ededed', '#3ecf8e', '#4d9dff', '#f5a623', '#1f1f1f', '#2a2a2a', '#3a3a3a', '#8f8f8f']);
    const used = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((match) => match[1] ?? '');
    expect(used.length).toBeGreaterThan(5);
    for (const color of used) expect(palette.has(color), color).toBe(true);
  });

  it('renders a different image for every challenge', () => {
    const first = renderCaptchaSvg('ABCDE');
    const second = renderCaptchaSvg('ABCDE');
    expect(first).not.toBe(second);
  });

  it('never stores the answer in clear text', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    const row = queryOne<{ answer_hash: string }>(
      'SELECT answer_hash FROM captcha_challenges WHERE id = ?',
      [created.id],
    );
    expect(row?.answer_hash).toBe(hashCaptchaAnswer(created.id, 'ABCDE'));
    expect(String(row?.answer_hash)).not.toContain('ABCDE');
    expect(String(row?.answer_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('captcha: verification', () => {
  it('accepts the right answer case-insensitively', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    expect(verifyCaptcha(created.id, 'abcde', NOW)).toBe(true);

    const second = createCaptcha(NOW, { answer: 'QWERT' });
    expect(verifyCaptcha(second.id, ' QwErT ', NOW)).toBe(true);
  });

  it('is one-time: a consumed challenge never verifies again', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    expect(verifyCaptcha(created.id, 'ABCDE', NOW)).toBe(true);
    expect(verifyCaptcha(created.id, 'ABCDE', NOW)).toBe(false);
    expect(remainingCaptchaAttempts(created.id, NOW)).toBe(0);
    const row = queryOne<{ consumed_at: number | null }>(
      'SELECT consumed_at FROM captcha_challenges WHERE id = ?',
      [created.id],
    );
    expect(Number(row?.consumed_at)).toBe(NOW);
  });

  it('expires after five minutes', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    expect(verifyCaptcha(created.id, 'ABCDE', NOW + CAPTCHA_TTL_MS - 1)).toBe(true);

    const stale = createCaptcha(NOW, { answer: 'ABCDE' });
    expect(verifyCaptcha(stale.id, 'ABCDE', NOW + CAPTCHA_TTL_MS + 1)).toBe(false);
    expect(remainingCaptchaAttempts(stale.id, NOW + CAPTCHA_TTL_MS + 1)).toBe(0);
  });

  it('burns the challenge after five wrong answers', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    for (let attempt = 0; attempt < CAPTCHA_MAX_ATTEMPTS; attempt += 1) {
      expect(verifyCaptcha(created.id, 'ZZZZZ', NOW), `attempt ${attempt}`).toBe(false);
    }
    // Even the correct answer cannot rescue a burned challenge.
    expect(verifyCaptcha(created.id, 'ABCDE', NOW)).toBe(false);
    expect(remainingCaptchaAttempts(created.id, NOW)).toBe(0);
  });

  it('keeps the challenge alive while attempts remain', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    expect(verifyCaptcha(created.id, 'ZZZZZ', NOW)).toBe(false);
    expect(remainingCaptchaAttempts(created.id, NOW)).toBe(CAPTCHA_MAX_ATTEMPTS - 1);
    expect(verifyCaptcha(created.id, 'ABCDE', NOW)).toBe(true);
  });

  it('rejects unknown ids and malformed answers without throwing', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    expect(verifyCaptcha('does-not-exist', 'ABCDE', NOW)).toBe(false);
    expect(verifyCaptcha('', 'ABCDE', NOW)).toBe(false);
    expect(verifyCaptcha(undefined, 'ABCDE', NOW)).toBe(false);
    expect(verifyCaptcha(created.id, '', NOW)).toBe(false);
    expect(verifyCaptcha(created.id, undefined, NOW)).toBe(false);
    expect(verifyCaptcha(created.id, 123456, NOW)).toBe(false);
    expect(verifyCaptcha(created.id, 'A'.repeat(17), NOW)).toBe(false);
    // None of those touched the attempt counter of a well-formed challenge.
    expect(remainingCaptchaAttempts(created.id, NOW)).toBe(CAPTCHA_MAX_ATTEMPTS);
  });

  it('normalizes answers the way the UI submits them', () => {
    expect(normalizeCaptchaAnswer(' abcd ')).toBe('ABCD');
    expect(normalizeCaptchaAnswer('')).toBeNull();
    expect(normalizeCaptchaAnswer(null)).toBeNull();
    expect(normalizeCaptchaAnswer(42)).toBeNull();
  });

  it('prunes challenges that expired more than one TTL ago', () => {
    const old = createCaptcha(NOW, { answer: 'ABCDE' });
    createCaptcha(NOW + 3 * CAPTCHA_TTL_MS, { answer: 'ABCDE' });
    expect(queryOne('SELECT id FROM captcha_challenges WHERE id = ?', [old.id])).toBeUndefined();
  });

  it('lets exactly one of two concurrent correct submissions win', () => {
    const created = createCaptcha(NOW, { answer: 'ABCDE' });
    // Simulate the race: both reads see an unconsumed row, only one UPDATE matches.
    const first = execute(
      'UPDATE captcha_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
      [NOW, created.id],
    );
    const second = execute(
      'UPDATE captcha_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
      [NOW, created.id],
    );
    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
    expect(verifyCaptcha(created.id, 'ABCDE', NOW)).toBe(false);
  });
});
