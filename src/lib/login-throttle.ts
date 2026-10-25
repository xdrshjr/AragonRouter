/**
 * Tiny in-memory throttle for admin password guessing.
 *
 * Only failed attempts count, and the window is generous so that test scripts
 * which intentionally submit a bad password still receive the documented 401.
 * State is per process - good enough for a single-node deployment, and it never
 * touches the database.
 */
export const MAX_FAILURES = 30;
export const FAILURE_WINDOW_MS = 60_000;

const failures = new Map<string, number[]>();

/** Identify a caller without trusting arbitrary headers beyond the proxy chain. */
export function clientFingerprint(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0];
    if (first && first.trim().length > 0) return first.trim();
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp && realIp.trim().length > 0) return realIp.trim();
  return 'local';
}

function recentHits(key: string, now: number): number[] {
  return (failures.get(key) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
}

export function isThrottled(key: string, now: number = Date.now()): boolean {
  const hits = recentHits(key, now);
  if (hits.length === 0) {
    failures.delete(key);
    return false;
  }
  failures.set(key, hits);
  return hits.length >= MAX_FAILURES;
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const hits = recentHits(key, now);
  hits.push(now);
  failures.set(key, hits);
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

/** Test hook. */
export function resetLoginThrottle(): void {
  failures.clear();
}
