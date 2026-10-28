/**
 * Client-side validation mirroring the gateway's own rules.
 *
 * The server (C5/C6/C-USERS-WIRE) stays the authority - these checks exist so an
 * operator gets an inline message instead of a round-trip, and so a malformed value
 * never reaches `/api/admin/**`. The limits below match `src/lib/apikeys.ts`,
 * `src/lib/providers.ts` and `src/lib/password.ts`; `tests/ui/validation.test.ts`
 * and `tests/ui/users-panel.test.tsx` pin them.
 *
 * The account rules are not re-implemented here: the sign-in dialog already ships
 * `@/components/auth/validation` (username / password / display-name policy), and a
 * second copy is exactly how the two forms drift apart. This module composes those
 * predicates into the administrator's create/edit/reset forms.
 */

import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateDisplayNameInput,
  validatePasswordInput,
  validateUsernameInput,
} from '@/components/auth/validation';
import type {
  CreateProviderPayload,
  CreateUserPayload,
  Protocol,
  UpdateProviderPayload,
  UpdateUserPayload,
  UserPublic,
  UserRole,
  UserStatus,
} from '@/components/console/types';
import { PROTOCOLS, USER_ROLES, USER_STATUSES } from '@/components/console/types';

export const NAME_MAX_LENGTH = 64;
export const BASE_URL_MAX_LENGTH = 500;
export const API_KEY_MAX_LENGTH = 4096;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Field name -> message. Empty when the form is valid. */
export type ValidationErrors = Record<string, string>;

/** Strip control characters and surrounding whitespace, exactly like the API. */
export function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** C5: a key name is a non-empty, <= 64 character label. */
export function validateKeyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter a name for this key.';
  if (CONTROL_CHARACTERS.test(raw)) return 'The name contains characters that are not allowed.';
  const name = raw.trim();
  if (name.length === 0) return 'Enter a name for this key.';
  if (name.length > NAME_MAX_LENGTH) {
    return `The name must be at most ${NAME_MAX_LENGTH} characters.`;
  }
  return null;
}

/** C6: provider display name. */
export function validateProviderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter a name for this provider.';
  if (CONTROL_CHARACTERS.test(raw)) return 'The name contains characters that are not allowed.';
  const name = raw.trim();
  if (name.length === 0) return 'Enter a name for this provider.';
  if (name.length > NAME_MAX_LENGTH) {
    return `The name must be at most ${NAME_MAX_LENGTH} characters.`;
  }
  return null;
}

/**
 * C6: `baseUrl` must be an absolute http(s) URL without embedded credentials.
 * A trailing slash is tolerated (the gateway strips it) so operators can paste
 * either form.
 */
export function validateBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter the upstream base URL.';
  if (CONTROL_CHARACTERS.test(raw)) return 'The URL contains characters that are not allowed.';
  const value = raw.trim();
  if (value.length === 0) return 'Enter the upstream base URL.';
  if (value.length > BASE_URL_MAX_LENGTH) {
    return `The URL must be at most ${BASE_URL_MAX_LENGTH} characters.`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter an absolute URL, for example https://api.anthropic.com.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The URL must use http or https.';
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return 'The URL must not contain credentials.';
  }
  if (parsed.hostname.length === 0) {
    return 'Enter an absolute URL, for example https://api.anthropic.com.';
  }
  return null;
}

/** C6: protocol must be one of the two supported families. */
export function validateProtocol(raw: unknown): string | null {
  if (typeof raw !== 'string' || !(PROTOCOLS as readonly string[]).includes(raw)) {
    return 'Choose the upstream protocol.';
  }
  return null;
}

/**
 * C6: upstream credential. On edit the field may be left blank, which keeps the
 * stored ciphertext untouched.
 */
export function validateApiKey(raw: unknown, options: { required?: boolean } = {}): string | null {
  const required = options.required ?? true;
  if (typeof raw !== 'string') {
    return required ? 'Enter the upstream API key.' : null;
  }
  if (CONTROL_CHARACTERS.test(raw)) return 'The key contains characters that are not allowed.';
  const value = raw.trim();
  if (value.length === 0) return required ? 'Enter the upstream API key.' : null;
  if (value.length > API_KEY_MAX_LENGTH) {
    return `The key must be at most ${API_KEY_MAX_LENGTH} characters.`;
  }
  return null;
}

/** The session password must be non-empty; the server decides whether it is right. */
export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'Enter the admin password.';
  return null;
}

export interface ProviderFormValues {
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export const EMPTY_PROVIDER_FORM: ProviderFormValues = {
  name: '',
  protocol: 'anthropic',
  baseUrl: '',
  apiKey: '',
  enabled: true,
};

/** Validate the whole provider form. `mode: 'edit'` makes `apiKey` optional. */
export function validateProviderForm(
  values: ProviderFormValues,
  options: { mode: 'create' | 'edit' } = { mode: 'create' },
): ValidationErrors {
  const errors: ValidationErrors = {};
  const name = validateProviderName(values.name);
  if (name) errors.name = name;
  const protocol = validateProtocol(values.protocol);
  if (protocol) errors.protocol = protocol;
  const baseUrl = validateBaseUrl(values.baseUrl);
  if (baseUrl) errors.baseUrl = baseUrl;
  const apiKey = validateApiKey(values.apiKey, { required: options.mode === 'create' });
  if (apiKey) errors.apiKey = apiKey;
  return errors;
}

export function hasErrors(errors: ValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Canonicalise a URL the way the gateway does: trim and drop trailing slashes. */
export function normalizeBaseUrlInput(value: string): string {
  return sanitizeText(value).replace(/\/+$/, '');
}

/** Build the `POST /api/admin/providers` body from validated form values. */
export function buildCreateProviderPayload(values: ProviderFormValues): CreateProviderPayload {
  return {
    name: sanitizeText(values.name),
    protocol: values.protocol as Protocol,
    baseUrl: normalizeBaseUrlInput(values.baseUrl),
    apiKey: values.apiKey.trim(),
    enabled: values.enabled,
  };
}

/**
 * Build the `PATCH /api/admin/providers/[id]` body.
 * A blank `apiKey` is omitted so the stored credential is preserved (C6).
 */
export function buildUpdateProviderPayload(values: ProviderFormValues): UpdateProviderPayload {
  const payload: UpdateProviderPayload = {
    name: sanitizeText(values.name),
    protocol: values.protocol as Protocol,
    baseUrl: normalizeBaseUrlInput(values.baseUrl),
    enabled: values.enabled,
  };
  const apiKey = values.apiKey.trim();
  if (apiKey.length > 0) payload.apiKey = apiKey;
  return payload;
}

/* -------------------------------------------------------------------------- */
/* C-USERS-WIRE - accounts (administrator)                                    */
/* -------------------------------------------------------------------------- */

/** The username/password/display-name budget, re-exported so callers have one source. */
export const USER_USERNAME_MIN_LENGTH = USERNAME_MIN_LENGTH;
export const USER_USERNAME_MAX_LENGTH = USERNAME_MAX_LENGTH;
export const USER_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;
/**
 * Upper password bound.
 *
 * `src/lib/password.ts` refuses anything longer than 200 characters
 * (`MAX_PASSWORD_LENGTH`), but the shared sign-in validator only enforces the lower
 * bound. A 300-character password would therefore pass this form's pre-flight check
 * and be refused by the server afterwards - graceful, but not the mirror the account
 * dialogs promise. The console owns the administrator forms, so the missing half of
 * the policy is enforced here rather than by editing the auth-ui module.
 */
export const USER_PASSWORD_MAX_LENGTH = 200;
export const USER_DISPLAY_NAME_MAX_LENGTH = DISPLAY_NAME_MAX_LENGTH;

/** The list `search` term is pasted into a LIKE pattern; 64 characters is plenty. */
export const USER_SEARCH_MAX_LENGTH = 64;

/** Create-account dialog values. The role defaults to `member`, like the API. */
export interface UserFormValues {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}

export interface UserFormErrors {
  username: string | null;
  displayName: string | null;
  password: string | null;
  role: string | null;
}

export const EMPTY_USER_FORM: UserFormValues = {
  username: '',
  displayName: '',
  password: '',
  role: 'member',
};

export function emptyUserFormErrors(): UserFormErrors {
  return { username: null, displayName: null, password: null, role: null };
}

export function hasUserFormErrors(errors: UserFormErrors): boolean {
  return (
    errors.username !== null ||
    errors.displayName !== null ||
    errors.password !== null ||
    errors.role !== null
  );
}

/** C-USERS-WIRE: `role` must be one of the two published values. */
export function validateUserRoleInput(raw: unknown): string | null {
  if (typeof raw !== 'string' || !(USER_ROLES as readonly string[]).includes(raw)) {
    return "Choose 'admin' or 'member'.";
  }
  return null;
}

/** C-USERS-WIRE: `status` filtering / patching uses the two published values. */
export function validateUserStatusInput(raw: unknown): string | null {
  if (typeof raw !== 'string' || !(USER_STATUSES as readonly string[]).includes(raw)) {
    return "Choose 'active' or 'disabled'.";
  }
  return null;
}

/**
 * Enforce the server's upper password bound.
 *
 * Exported so the create dialog, the reset dialog and the tests share one rule. It
 * runs *before* the shared validator because `validatePasswordStrength` checks the
 * length first as well: a 300-character password is refused for being long, not for
 * whatever else it happens to contain.
 *
 * @param raw - candidate password, any type (non-strings are left to the shared
 *   validator, which owns the "enter a password" message)
 * @returns `null` when the length is acceptable, otherwise the inline message
 */
export function validateUserPasswordBudget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > USER_PASSWORD_MAX_LENGTH) {
    return `The password must be at most ${USER_PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

/**
 * Validate the create-account form.
 *
 * Mirrors `createUser` on the server: `validateUsername`, then the password policy of
 * `validatePasswordStrength(password, username)` (length window included, so a
 * password containing the username is refused before the request), then the
 * display-name budget. The only rule a browser cannot reproduce is uniqueness - that
 * stays a 400 the dialog shows inline.
 */
export function validateUserForm(values: UserFormValues): UserFormErrors {
  return {
    username: validateUsernameInput(values.username),
    displayName: validateDisplayNameInput(values.displayName),
    password: validateUserPassword(values.password, values.username),
    role: validateUserRoleInput(values.role),
  };
}

/** Reset-password dialog: same policy as a sign-up, without the display name. */
export function validateUserPassword(raw: unknown, username: string): string | null {
  const overBudget = validateUserPasswordBudget(raw);
  if (overBudget) return overBudget;
  return validatePasswordInput(raw, { mode: 'register', username });
}

/** Build the `POST /api/admin/users` body. A blank display name is omitted. */
export function buildCreateUserPayload(values: UserFormValues): CreateUserPayload {
  const payload: CreateUserPayload = {
    username: sanitizeText(values.username),
    password: values.password,
    role: values.role,
  };
  const displayName = sanitizeText(values.displayName);
  if (displayName.length > 0) payload.displayName = displayName;
  return payload;
}

/** Edit-account dialog values (`PATCH /api/admin/users/[id]`). */
export interface UserEditValues {
  displayName: string;
  role: UserRole;
  status: UserStatus;
}

export interface UserEditErrors {
  displayName: string | null;
  role: string | null;
  status: string | null;
}

export function userEditValuesOf(user: UserPublic): UserEditValues {
  return { displayName: user.displayName ?? '', role: user.role, status: user.status };
}

export function emptyUserEditErrors(): UserEditErrors {
  return { displayName: null, role: null, status: null };
}

export function hasUserEditErrors(errors: UserEditErrors): boolean {
  return errors.displayName !== null || errors.role !== null || errors.status !== null;
}

export function validateUserEditForm(values: UserEditValues): UserEditErrors {
  return {
    displayName: validateDisplayNameInput(values.displayName),
    role: validateUserRoleInput(values.role),
    status: validateUserStatusInput(values.status),
  };
}

/** Build the `PATCH /api/admin/users/[id]` body: `null` clears the display name. */
export function buildUpdateUserPayload(values: UserEditValues): UpdateUserPayload {
  const displayName = sanitizeText(values.displayName);
  return {
    displayName: displayName.length > 0 ? displayName : null,
    role: values.role,
    status: values.status,
  };
}

/** Canonicalise the debounced search term the list query will carry. */
export function normalizeUserSearch(value: unknown): string {
  if (typeof value !== 'string') return '';
  return sanitizeText(value).slice(0, USER_SEARCH_MAX_LENGTH);
}

/**
 * Operator copy for a rejected account action.
 *
 * `withAdmin` answers 403 for a member and `mapDomainError` returns the domain
 * error's own wording, which is deliberately terse API language ("at least one
 * active admin must remain"). The store's messages are stable strings, so they are
 * translated here instead of being rendered raw - while an unknown message is shown
 * unchanged rather than swallowed.
 */
const USER_RULE_COPY: Readonly<Record<string, string>> = {
  'at least one active admin must remain':
    'At least one active admin must remain. Promote another account to admin first.',
  'you cannot disable your own account':
    'You cannot disable your own account. Ask another administrator to do it.',
  'you cannot remove your own admin role':
    'You cannot remove your own admin role. Ask another administrator to do it.',
  'you cannot delete your own account':
    'You cannot delete your own account. Ask another administrator to do it.',
  'username is already taken': 'That username is already taken. Pick another one.',
  'user not found': 'That account no longer exists. Refresh the list and try again.',
  'username is required': 'Enter a username.',
  'username must be at least 3 characters': 'The username must be at least 3 characters.',
  'username must be at most 32 characters': 'The username must be at most 32 characters.',
  // The store builds this sentence from two literals; the key is the joined result.
  ['username may only contain letters, digits, dot, dash and underscore, and must start ' +
    'with a letter or digit']:
    'Use letters, digits, dot, dash or underscore, starting with a letter or digit.',
  'password is required': 'Enter a password.',
  'password must be at least 8 characters': 'The password must be at least 8 characters.',
  'password must be at most 200 characters': 'The password must be at most 200 characters.',
  'password must contain at least one letter': 'The password must contain at least one letter.',
  'password must contain at least one digit': 'The password must contain at least one digit.',
  'password must not contain the username': 'The password must not contain the username.',
  'displayname must be a string': 'Enter a display name or leave the field empty.',
  'displayname must be at most 64 characters':
    'The display name must be at most 64 characters.',
  "role must be 'admin' or 'member'": "Choose 'admin' or 'member'.",
  "status must be 'active' or 'disabled'": "Choose 'active' or 'disabled'.",
};

/** Translate one server message into operator copy; never returns an empty string. */
export function describeUserRuleMessage(message: string): string {
  if (typeof message !== 'string' || message.trim().length === 0) {
    return 'The account change was refused.';
  }
  const key = message.trim().toLowerCase();
  // Own-property lookup only: `USER_RULE_COPY['constructor']` would otherwise return
  // Object's constructor and `['__proto__']` its prototype, both of which are truthy
  // but not strings - rendering one of those as copy would crash the dialog.
  const mapped = Object.prototype.hasOwnProperty.call(USER_RULE_COPY, key)
    ? USER_RULE_COPY[key]
    : undefined;
  return mapped ?? message.trim();
}
