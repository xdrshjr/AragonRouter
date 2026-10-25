import { beforeEach, describe, expect, it } from 'vitest';
import {
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  clearFailures,
  clientFingerprint,
  isThrottled,
  recordFailure,
  resetLoginThrottle,
} from '@/lib/login-throttle';

const T0 = 1_700_000_000_000;

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/admin/session', { method: 'POST', headers });
}

beforeEach(() => {
  resetLoginThrottle();
});

describe('login-throttle: fingerprinting', () => {
  it('uses the first x-forwarded-for hop, then x-real-ip, then a local fallback', () => {
    expect(clientFingerprint(request({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(clientFingerprint(request({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
    expect(clientFingerprint(request({ 'x-forwarded-for': '   ', 'x-real-ip': '198.51.100.8' }))).toBe('198.51.100.8');
    expect(clientFingerprint(request())).toBe('local');
  });
});

describe('login-throttle: lockout behaviour', () => {
  it('locks out exactly after MAX_FAILURES failures inside the window', () => {
    for (let attempt = 0; attempt < MAX_FAILURES - 1; attempt += 1) {
      recordFailure('client-a', T0);
    }
    expect(isThrottled('client-a', T0)).toBe(false);

    recordFailure('client-a', T0);
    expect(isThrottled('client-a', T0)).toBe(true);
  });

  it('forgets failures once the window has passed', () => {
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      recordFailure('client-b', T0);
    }
    expect(isThrottled('client-b', T0 + FAILURE_WINDOW_MS - 1)).toBe(true);
    expect(isThrottled('client-b', T0 + FAILURE_WINDOW_MS)).toBe(false);
  });

  it('tracks clients independently and can be cleared', () => {
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      recordFailure('client-c', T0);
    }
    expect(isThrottled('client-c', T0)).toBe(true);
    expect(isThrottled('client-d', T0)).toBe(false);

    clearFailures('client-c');
    expect(isThrottled('client-c', T0)).toBe(false);

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      recordFailure('client-e', T0);
    }
    resetLoginThrottle();
    expect(isThrottled('client-e', T0)).toBe(false);
  });

  it('keeps the lockout threshold generous enough for a test script', () => {
    expect(MAX_FAILURES).toBeGreaterThanOrEqual(10);
    expect(FAILURE_WINDOW_MS).toBeGreaterThanOrEqual(1_000);
  });
});
