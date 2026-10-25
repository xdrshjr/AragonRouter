import { describe, expect, it } from 'vitest';
import { EncryptionError, hmacSha256Hex, open, seal, sha256Hex, timingSafeEqualString } from '@/lib/crypto';
import { ConfigurationError } from '@/lib/env';
import { TEST_ENCRYPTION_KEY } from './test-helpers';

describe('crypto: AES-256-GCM seal/open', () => {
  it('round-trips a provider key', () => {
    const payload = seal('sk-ant-super-secret', TEST_ENCRYPTION_KEY);
    expect(payload).not.toContain('sk-ant-super-secret');
    expect(open(payload, TEST_ENCRYPTION_KEY)).toBe('sk-ant-super-secret');
  });

  it('never produces the same ciphertext twice (fresh IV per call)', () => {
    const first = seal('same-plaintext', TEST_ENCRYPTION_KEY);
    const second = seal('same-plaintext', TEST_ENCRYPTION_KEY);
    expect(first).not.toBe(second);
    expect(open(first, TEST_ENCRYPTION_KEY)).toBe('same-plaintext');
    expect(open(second, TEST_ENCRYPTION_KEY)).toBe('same-plaintext');
  });

  it('stores the payload as base64 of iv|tag|ciphertext with a fresh IV', () => {
    const first = Buffer.from(seal('abc', TEST_ENCRYPTION_KEY), 'base64');
    const second = Buffer.from(seal('abc', TEST_ENCRYPTION_KEY), 'base64');
    // 12 byte IV + 16 byte tag + 3 ciphertext bytes for 'abc'
    expect(first.length).toBe(12 + 16 + 3);
    expect(first.subarray(0, 12).equals(second.subarray(0, 12))).toBe(false);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const payload = seal('provider-key', TEST_ENCRYPTION_KEY);
    const raw = Buffer.from(payload, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    expect(() => open(raw.toString('base64'), TEST_ENCRYPTION_KEY)).toThrow(EncryptionError);
  });

  it('rejects the wrong key', () => {
    const payload = seal('provider-key', TEST_ENCRYPTION_KEY);
    const otherKey = 'f'.repeat(64);
    expect(() => open(payload, otherKey)).toThrow(EncryptionError);
  });

  it('rejects truncated and empty payloads', () => {
    expect(() => open('', TEST_ENCRYPTION_KEY)).toThrow(EncryptionError);
    expect(() => open(Buffer.alloc(4).toString('base64'), TEST_ENCRYPTION_KEY)).toThrow(EncryptionError);
  });

  it('requires a 64 hex character ENCRYPTION_KEY', () => {
    expect(() => seal('x', 'too-short')).toThrow(ConfigurationError);
    expect(() => seal('x', 'z'.repeat(64))).toThrow(ConfigurationError);
    expect(() => seal('x', 'a'.repeat(63))).toThrow(ConfigurationError);
  });

  it('fails when ENCRYPTION_KEY is missing from the environment', () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => seal('x')).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });
});

describe('crypto: hashing helpers', () => {
  it('sha256Hex is stable and hex encoded', () => {
    expect(sha256Hex('ar-key')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('ar-key')).toBe(sha256Hex('ar-key'));
    expect(sha256Hex('ar-key')).not.toBe(sha256Hex('ar-key2'));
  });

  it('hmacSha256Hex is keyed', () => {
    expect(hmacSha256Hex('secret-a', 'payload')).not.toBe(hmacSha256Hex('secret-b', 'payload'));
    expect(hmacSha256Hex('secret-a', 'payload')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('timingSafeEqualString compares values of different lengths safely', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
    expect(timingSafeEqualString('a', '')).toBe(false);
  });
});
