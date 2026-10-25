/**
 * Locale-independent presentation helpers.
 *
 * Deliberately free of `Intl` defaults and of `toLocaleString()`: the console
 * must render identical output on every machine (and in tests), and a page that
 * formats a number differently after hydration is a React hydration error.
 */

const THOUSANDS = /(\d)(?=(\d{3})+(?!\d))/g;

/** `12345` -> `12,345`. Negatives and fractions are left intact. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${String(Math.abs(rounded)).replace(THOUSANDS, '$1,')}`;
}

/** `1234` -> `1.2k`, `1234567` -> `1.2M`. Used for axis labels and chips. */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute < 1000) return `${sign}${Math.round(absolute)}`;
  if (absolute < 1_000_000) return `${sign}${trimZero(absolute / 1000)}k`;
  if (absolute < 1_000_000_000) return `${sign}${trimZero(absolute / 1_000_000)}M`;
  return `${sign}${trimZero(absolute / 1_000_000_000)}B`;
}

function trimZero(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** Token counts are large; the full value stays available via the `title` tooltip. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return formatCompactNumber(value);
}

/** C7 `errorRate` is a 0-1 fraction. `0.0243` -> `2.43%`. */
export function formatPercent(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  const percent = fraction * 100;
  if (percent >= 100) return `${Math.round(percent)}%`;
  // Keep a non-zero rate visible: "0.004%" carries information, "0%" does not.
  if (percent < 0.01) return '<0.01%';
  const fixed = percent.toFixed(digits);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return `${trimmed}%`;
}

/** `87` -> `87 ms`, `2480` -> `2.48 s`. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds >= 100 ? seconds.toFixed(0) : seconds.toFixed(2)} s`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `2024-06-01T12:34:56.000Z` -> `2024-06-01 12:34:56` (local time, no locale calls). */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return '—';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Shorter variant for dense tables: `2024-06-01 12:34`. */
export function formatDateTimeShort(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return '—';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Axis label for one C7 series bucket. `24h` -> `14:00`, `7d`/`30d` -> `06-01`. */
export function formatBucketLabel(iso: string, range: '24h' | '7d' | '30d'): string {
  const date = parseDate(iso);
  if (!date) return '—';
  if (range === '24h') return `${pad(date.getHours())}:00`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `just now`, `4 min ago`, `3 h ago`, `2 d ago`, then an absolute date. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parseDate(iso);
  if (!date) return 'never';
  const deltaMs = now - date.getTime();
  if (!Number.isFinite(deltaMs)) return 'never';
  // A clock skew between server and browser must not produce "-3 min ago".
  if (deltaMs < 45_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDateTimeShort(iso);
}

/** Keep both ends of a long identifier: `sk-abcd…wxyz`. */
export function truncateMiddle(value: string, max = 24): string {
  if (value.length <= max) return value;
  const keep = Math.max(2, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Insert a hair space so a long value wraps inside table cells. */
export function truncateEnd(value: string, max = 64): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Map an HTTP status onto the badge tone used in the logs and overview tables. */
export function statusTone(status: number): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (!Number.isFinite(status) || status <= 0) return 'neutral';
  if (status < 300) return 'success';
  if (status < 400) return 'info';
  if (status < 500) return 'warning';
  return 'danger';
}

function parseDate(iso: string | null | undefined): Date | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
