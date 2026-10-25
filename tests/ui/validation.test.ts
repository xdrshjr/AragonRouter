import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROVIDER_FORM,
  buildCreateProviderPayload,
  buildUpdateProviderPayload,
  hasErrors,
  normalizeBaseUrlInput,
  sanitizeText,
  validateApiKey,
  validateBaseUrl,
  validateKeyName,
  validatePassword,
  validateProtocol,
  validateProviderForm,
  validateProviderName,
  type ProviderFormValues,
} from '@/components/console/validation';

const VALID_FORM: ProviderFormValues = {
  name: 'Anthropic production',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-abc',
  enabled: true,
};

describe('sanitizeText', () => {
  it('strips control characters and trims', () => {
    expect(sanitizeText('  name\u0000\u001f  ')).toBe('name');
    expect(sanitizeText('plain')).toBe('plain');
  });
});

describe('validateKeyName', () => {
  it('accepts a normal name', () => {
    expect(validateKeyName('Production relay')).toBeNull();
  });

  it('rejects empty, non-string, control characters and over-long input', () => {
    expect(validateKeyName('')).not.toBeNull();
    expect(validateKeyName('   ')).not.toBeNull();
    expect(validateKeyName(undefined)).not.toBeNull();
    expect(validateKeyName(42)).not.toBeNull();
    expect(validateKeyName('bad\u0000name')).not.toBeNull();
    expect(validateKeyName('x'.repeat(65))).not.toBeNull();
    expect(validateKeyName('x'.repeat(64))).toBeNull();
  });
});

describe('validateProviderName', () => {
  it('mirrors the key-name rules', () => {
    expect(validateProviderName('Upstream A')).toBeNull();
    expect(validateProviderName('')).not.toBeNull();
    expect(validateProviderName('x'.repeat(65))).not.toBeNull();
  });
});

describe('validateBaseUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(validateBaseUrl('https://api.anthropic.com')).toBeNull();
    expect(validateBaseUrl('http://127.0.0.1:8080')).toBeNull();
    expect(validateBaseUrl(' https://api.openai.com/v1 ')).toBeNull();
  });

  it('rejects relative, credential-bearing and non-http URLs', () => {
    expect(validateBaseUrl('api.anthropic.com')).not.toBeNull();
    expect(validateBaseUrl('/local/path')).not.toBeNull();
    expect(validateBaseUrl('ftp://example.com')).not.toBeNull();
    expect(validateBaseUrl('https://user:pass@example.com')).not.toBeNull();
    expect(validateBaseUrl('javascript:alert(1)')).not.toBeNull();
    expect(validateBaseUrl('')).not.toBeNull();
    expect(validateBaseUrl(null)).not.toBeNull();
  });

  it('rejects control characters and over-long URLs', () => {
    expect(validateBaseUrl('https://example.com/\u0000')).not.toBeNull();
    expect(validateBaseUrl(`https://example.com/${'a'.repeat(500)}`)).not.toBeNull();
  });
});

describe('validateProtocol', () => {
  it('accepts the two supported families only', () => {
    expect(validateProtocol('anthropic')).toBeNull();
    expect(validateProtocol('openai')).toBeNull();
    expect(validateProtocol('gemini')).not.toBeNull();
    expect(validateProtocol('')).not.toBeNull();
  });
});

describe('validateApiKey', () => {
  it('requires a value when creating', () => {
    expect(validateApiKey('sk-1')).toBeNull();
    expect(validateApiKey('')).not.toBeNull();
    expect(validateApiKey('   ')).not.toBeNull();
  });

  it('allows blank when editing (keeps the stored credential)', () => {
    expect(validateApiKey('', { required: false })).toBeNull();
    expect(validateApiKey('   ', { required: false })).toBeNull();
  });

  it('rejects control characters and over-long keys', () => {
    expect(validateApiKey('sk-\u0007bad')).not.toBeNull();
    expect(validateApiKey('k'.repeat(4097))).not.toBeNull();
    expect(validateApiKey('k'.repeat(4096))).toBeNull();
  });
});

describe('validatePassword', () => {
  it('only rejects an empty password (the server decides correctness)', () => {
    expect(validatePassword('anything')).toBeNull();
    expect(validatePassword('')).not.toBeNull();
    expect(validatePassword(null)).not.toBeNull();
  });
});

describe('validateProviderForm', () => {
  it('accepts a complete create form', () => {
    expect(validateProviderForm(VALID_FORM, { mode: 'create' })).toEqual({});
  });

  it('reports every invalid field at once', () => {
    const errors = validateProviderForm(
      { name: '', protocol: 'nope', baseUrl: 'not-a-url', apiKey: '', enabled: true },
      { mode: 'create' },
    );
    expect(Object.keys(errors).sort()).toEqual(['apiKey', 'baseUrl', 'name', 'protocol']);
    expect(hasErrors(errors)).toBe(true);
  });

  it('does not require the key in edit mode', () => {
    const errors = validateProviderForm({ ...VALID_FORM, apiKey: '' }, { mode: 'edit' });
    expect(errors.apiKey).toBeUndefined();
    expect(hasErrors(errors)).toBe(false);
  });
});

describe('payload builders', () => {
  it('normalizes the create payload (trim, strip trailing slashes)', () => {
    const payload = buildCreateProviderPayload({
      ...VALID_FORM,
      name: '  An thropic  ',
      baseUrl: 'https://api.anthropic.com///',
      apiKey: '  sk-ant-abc  ',
    });
    expect(payload).toEqual({
      name: 'An thropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-abc',
      enabled: true,
    });
  });

  it('omits a blank apiKey so PATCH keeps the stored credential', () => {
    const payload = buildUpdateProviderPayload({ ...VALID_FORM, apiKey: '   ' });
    expect('apiKey' in payload).toBe(false);
    expect(payload.enabled).toBe(true);
  });

  it('includes a new apiKey when one was typed', () => {
    const payload = buildUpdateProviderPayload({ ...VALID_FORM, apiKey: ' sk-new ' });
    expect(payload.apiKey).toBe('sk-new');
  });

  it('normalizeBaseUrlInput matches the gateway canonicalisation', () => {
    expect(normalizeBaseUrlInput('  https://x.test//  ')).toBe('https://x.test');
  });

  it('ships a sane empty form (anthropic, enabled)', () => {
    expect(EMPTY_PROVIDER_FORM.protocol).toBe('anthropic');
    expect(EMPTY_PROVIDER_FORM.enabled).toBe(true);
    expect(EMPTY_PROVIDER_FORM.apiKey).toBe('');
  });
});
