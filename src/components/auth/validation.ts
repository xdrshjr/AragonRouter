/**
 * Client-side validation for the sign-in / sign-up form.
 *
 * The server stays the authority (`src/lib/password.ts` enforces the same policy
 * inside `createUser`); these checks exist so a visitor gets an inline message
 * instead of a round-trip, and so an empty or malformed value never leaves the
 * browser. The limits below are a mirror of the gateway rules, which
 * `tests/ui/auth-flow.test.tsx` pins against the real handlers.
 */

import type { AuthMode } from '@/components/console/types';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 8;
export const DISPLAY_NAME_MAX_LENGTH = 64;
export const CAPTCHA_ANSWER_MAX_LENGTH = 16;

/** Usernames may not look like a path segment or a header. */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Fragments shorter than this are not searched for inside the password. */
const MIN_NAME_FRAGMENT_LENGTH = 3;

export interface AuthFormValues {
  username: string;
  password: string;
  displayName: string;
  captchaAnswer: string;
}

/** One entry per control, plus a form-level message. */
export interface AuthFormErrors {
  username: string | null;
  password: string | null;
  displayName: string | null;
  captcha: string | null;
  form: string | null;
}

export const EMPTY_AUTH_VALUES: AuthFormValues = {
  username: '',
  password: '',
  displayName: '',
  captchaAnswer: '',
};

export function emptyAuthErrors(): AuthFormErrors {
  return { username: null, password: null, displayName: null, captcha: null, form: null };
}

/** True when any control (or the form itself) carries a message. */
export function hasAuthErrors(errors: AuthFormErrors): boolean {
  return (
    errors.username !== null ||
    errors.password !== null ||
    errors.displayName !== null ||
    errors.captcha !== null ||
    errors.form !== null
  );
}

/**
 * Name fragments a password must not contain: the whole username and every
 * word of at least three characters, lowercased - the same split the gateway uses
 * so a password accepted here is not rejected there.
 */
export function usernameFragments(username: string): string[] {
  const lower = username.trim().toLowerCase();
  const fragments = new Set<string>();
  if (lower.length >= MIN_NAME_FRAGMENT_LENGTH) fragments.add(lower);
  for (const part of lower.split(/[^a-z0-9]+/)) {
    if (part.length >= MIN_NAME_FRAGMENT_LENGTH) fragments.add(part);
  }
  const withoutDigits = lower.replace(/[0-9]+$/, '');
  if (withoutDigits.length >= MIN_NAME_FRAGMENT_LENGTH) fragments.add(withoutDigits);
  return [...fragments];
}

/** `null` when acceptable, otherwise the message shown under the field. */
export function validateUsernameInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter a username.';
  const username = raw.trim();
  if (username.length === 0) return 'Enter a username.';
  if (username.length < USERNAME_MIN_LENGTH) {
    return `The username must be at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return `The username must be at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!USERNAME_PATTERN.test(username)) {
    return 'Use letters, digits, dot, dash or underscore, starting with a letter or digit.';
  }
  return null;
}

/**
 * Password rules.
 *
 * Signing in only requires something to send - the server decides whether it is
 * right, and echoing a policy back at an existing account would leak it. Creating
 * an account mirrors the policy so the visitor is not told "too weak" by a 400.
 */
export function validatePasswordInput(
  raw: unknown,
  options: { mode: AuthMode; username: string },
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'Enter your password.';
  if (options.mode === 'login') return null;
  if (raw.length < PASSWORD_MIN_LENGTH) {
    return `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/\p{L}/u.test(raw)) return 'The password must contain at least one letter.';
  if (!/[0-9]/.test(raw)) return 'The password must contain at least one digit.';
  const haystack = raw.toLowerCase();
  if (usernameFragments(options.username).some((fragment) => haystack.includes(fragment))) {
    return 'The password must not contain the username.';
  }
  return null;
}

/** The display name is optional; only its budget and control characters matter. */
export function validateDisplayNameInput(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return 'Enter a display name or leave the field empty.';
  const trimmed = raw.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `The display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return 'The display name contains characters that are not allowed.';
  }
  return null;
}

/** The captcha answer is short; a wrong answer is the server's call. */
export function validateCaptchaInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter the security code.';
  const answer = raw.trim();
  if (answer.length === 0) return 'Enter the security code.';
  if (answer.length > CAPTCHA_ANSWER_MAX_LENGTH) {
    return `The security code is at most ${CAPTCHA_ANSWER_MAX_LENGTH} characters.`;
  }
  return null;
}

/** Validate the whole form for the given mode. */
export function validateAuthForm(mode: AuthMode, values: AuthFormValues): AuthFormErrors {
  return {
    username: validateUsernameInput(values.username),
    password: validatePasswordInput(values.password, { mode, username: values.username }),
    displayName: mode === 'register' ? validateDisplayNameInput(values.displayName) : null,
    captcha: validateCaptchaInput(values.captchaAnswer),
    form: null,
  };
}

/** The control that should receive focus after a failed validation. */
export function firstInvalidField(errors: AuthFormErrors): keyof AuthFormValues | null {
  if (errors.username) return 'username';
  if (errors.password) return 'password';
  if (errors.displayName) return 'displayName';
  if (errors.captcha) return 'captchaAnswer';
  return null;
}
