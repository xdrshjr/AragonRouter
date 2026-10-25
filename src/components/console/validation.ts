/**
 * Client-side validation mirroring the gateway's own rules.
 *
 * The server (C5/C6) stays the authority - these checks exist so an operator gets
 * an inline message instead of a round-trip, and so a malformed value never
 * reaches `/api/admin/**`. The limits below match `src/lib/apikeys.ts` and
 * `src/lib/providers.ts`; `tests/ui/validation.test.ts` pins them.
 */

import type { CreateProviderPayload, Protocol, UpdateProviderPayload } from '@/components/console/types';
import { PROTOCOLS } from '@/components/console/types';

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
  if (parsed.hostname.length === 0) return 'Enter an absolute URL, for example https://api.anthropic.com.';
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
