import { describe, expect, it } from 'vitest';
import {
  formatBucketLabel,
  formatCompactNumber,
  formatDateTime,
  formatDateTimeShort,
  formatLatency,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTokens,
  statusTone,
  truncateEnd,
  truncateMiddle,
} from '@/components/console/format';

describe('formatNumber', () => {
  it('groups thousands without a locale dependency', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(-1234)).toBe('-1,234');
  });

  it('survives non-finite input', () => {
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('rounds to whole units', () => {
    expect(formatNumber(12.6)).toBe('13');
  });
});

describe('formatCompactNumber', () => {
  it('abbreviates large values', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1200)).toBe('1.2k');
    expect(formatCompactNumber(1000)).toBe('1k');
    expect(formatCompactNumber(1_234_567)).toBe('1.2M');
    expect(formatCompactNumber(3_400_000_000)).toBe('3.4B');
    expect(formatCompactNumber(-1500)).toBe('-1.5k');
  });
});

describe('formatTokens', () => {
  it('shows an em dash for unknown usage', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(4321)).toBe('4.3k');
  });
});

describe('formatPercent', () => {
  it('renders a C7 error rate fraction', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0243)).toBe('2.43%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('keeps a tiny non-zero rate visible', () => {
    expect(formatPercent(0.000001)).toBe('<0.01%');
  });

  it('handles garbage input', () => {
    expect(formatPercent(Number.NaN)).toBe('0%');
    expect(formatPercent(-1)).toBe('0%');
  });
});

describe('formatLatency', () => {
  it('switches from milliseconds to seconds', () => {
    expect(formatLatency(0)).toBe('0 ms');
    expect(formatLatency(87.4)).toBe('87 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1000)).toBe('1.00 s');
    expect(formatLatency(2480)).toBe('2.48 s');
    expect(formatLatency(120_000)).toBe('120 s');
  });

  it('shows an em dash for missing values', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(undefined)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats an ISO timestamp without locale calls', () => {
    // Constructed from local parts so the assertion holds in any timezone.
    const date = new Date(2024, 5, 1, 12, 34, 56);
    expect(formatDateTime(date.toISOString())).toBe('2024-06-01 12:34:56');
    expect(formatDateTimeShort(date.toISOString())).toBe('2024-06-01 12:34');
  });

  it('rejects junk', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('')).toBe('—');
  });
});

describe('formatBucketLabel', () => {
  it('uses hours for 24h and dates for daily ranges', () => {
    const stamp = new Date(2024, 0, 2, 7, 0, 0).toISOString();
    expect(formatBucketLabel(stamp, '24h')).toBe('07:00');
    expect(formatBucketLabel(stamp, '7d')).toBe('01-02');
    expect(formatBucketLabel(stamp, '30d')).toBe('01-02');
    expect(formatBucketLabel('nope', '7d')).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date(2024, 0, 10, 12, 0, 0).getTime();

  it('describes recent timestamps', () => {
    expect(formatRelativeTime(new Date(now - 5_000).toISOString(), now)).toBe('just now');
    expect(formatRelativeTime(new Date(now - 4 * 60_000).toISOString(), now)).toBe('4 min ago');
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 h ago');
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 d ago');
  });

  it('never reports a negative age when the clocks disagree', () => {
    expect(formatRelativeTime(new Date(now + 60_000).toISOString(), now)).toBe('just now');
  });

  it('falls back to a date for old timestamps and for junk', () => {
    const old = new Date(now - 400 * 86_400_000);
    expect(formatRelativeTime(old.toISOString(), now)).toBe(formatDateTimeShort(old.toISOString()));
    expect(formatRelativeTime(null, now)).toBe('never');
    expect(formatRelativeTime('garbage', now)).toBe('never');
  });
});

describe('truncate helpers', () => {
  it('keeps both ends in the middle variant', () => {
    expect(truncateMiddle('short', 24)).toBe('short');
    // max 12 -> 5 leading characters, an ellipsis, 5 trailing characters.
    expect(truncateMiddle('ar-0123456789abcdef0123456789abcdef', 12)).toBe('ar-01…bcdef');
    expect(truncateMiddle('ar-0123456789abcdef0123456789abcdef', 12).length).toBeLessThanOrEqual(12);
  });

  it('clips the end for table cells', () => {
    expect(truncateEnd('abc', 10)).toBe('abc');
    expect(truncateEnd('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('statusTone', () => {
  it('maps HTTP statuses onto badge tones', () => {
    expect(statusTone(200)).toBe('success');
    expect(statusTone(204)).toBe('success');
    expect(statusTone(304)).toBe('info');
    expect(statusTone(429)).toBe('warning');
    expect(statusTone(500)).toBe('danger');
    expect(statusTone(502)).toBe('danger');
    expect(statusTone(0)).toBe('neutral');
    expect(statusTone(Number.NaN)).toBe('neutral');
  });
});
