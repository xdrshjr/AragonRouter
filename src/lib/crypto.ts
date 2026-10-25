import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigurationError, getEncryptionKeyHex } from '@/lib/env';

/** AES-256-GCM parameters. */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/** Decode `ENCRYPTION_KEY` (64 hex chars) into a 32 byte AES key. */
export function parseEncryptionKey(keyHex: string = getEncryptionKeyHex()): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new ConfigurationError(
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) for AES-256-GCM.',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a UTF-8 string.
 *
 * Payload layout (then base64 encoded): iv (12 bytes) | auth tag (16 bytes) | ciphertext.
 */
export function seal(plaintext: string, keyHex?: string): string {
  if (typeof plaintext !== 'string') {
    throw new EncryptionError('seal() expects a string plaintext');
  }
  const key = parseEncryptionKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a payload produced by {@link seal}. Throws {@link EncryptionError} on a
 * wrong key, truncated payload or failed authentication tag.
 */
export function open(payload: string, keyHex?: string): string {
  const key = parseEncryptionKey(keyHex);
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new EncryptionError('open() expects a non-empty base64 payload');
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(payload, 'base64');
  } catch {
    throw new EncryptionError('unable to decrypt provider key: payload is not valid base64');
  }
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new EncryptionError('unable to decrypt provider key: payload is truncated');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new EncryptionError(
      'unable to decrypt provider key: wrong ENCRYPTION_KEY or corrupted ciphertext',
    );
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two strings of arbitrary length.
 *
 * Both sides are hashed first so that the compared buffers always have the same
 * length, which keeps the timing independent of the secret length.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** URL-safe random identifier, used for row ids. */
export function newId(): string {
  return randomBytes(16).toString('hex');
}

/** Random opaque token. */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
