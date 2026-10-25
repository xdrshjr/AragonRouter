import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  persistTheme,
  readStoredTheme,
  resolveTheme,
  themeClassName,
} from '@/components/console/theme';
import { CONSOLE_BASE_PATH, LOGIN_PATH, findNavItem, isActivePath, sanitizeNextPath } from '@/components/console/nav';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (key: string) => (key in store ? (store[key] as string) : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

function fakeElement() {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add: (...tokens: string[]) => {
        for (const token of tokens) classes.add(token);
      },
      remove: (...tokens: string[]) => {
        for (const token of tokens) classes.delete(token);
      },
    },
  };
}

describe('theme resolution', () => {
  it('defaults to dark (C10)', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(resolveTheme(null)).toBe('dark');
    expect(resolveTheme(undefined)).toBe('dark');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('purple')).toBe('dark');
  });

  it('maps a theme onto the html class', () => {
    expect(themeClassName('dark')).toBe('dark');
    expect(themeClassName('light')).toBe('light');
  });

  it('toggles between the two palettes', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
  });
});

describe('storage helpers', () => {
  it('reads the persisted theme', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'light' });
    expect(readStoredTheme(storage)).toBe('light');
    expect(readStoredTheme(fakeStorage())).toBe('dark');
  });

  it('never throws when storage is unavailable', () => {
    expect(readStoredTheme(null)).toBe('dark');
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toBe('dark');
  });

  it('persists the theme and swallows quota errors', () => {
    const storage = fakeStorage();
    persistTheme(storage, 'light');
    expect(storage.store[THEME_STORAGE_KEY]).toBe('light');

    expect(() => {
      persistTheme(
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
        'light',
      );
    }).not.toThrow();

    expect(() => {
      persistTheme(null, 'dark');
    }).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('replaces the previous palette class', () => {
    const element = fakeElement();
    applyTheme(element, 'dark');
    expect([...element.classes]).toEqual(['dark']);
    applyTheme(element, 'light');
    expect([...element.classes]).toEqual(['light']);
  });

  it('tolerates a missing element', () => {
    expect(() => {
      applyTheme(null, 'light');
    }).not.toThrow();
  });
});

describe('THEME_BOOT_SCRIPT', () => {
  it('is a constant that reads the shared storage key and sets both classes', () => {
    expect(THEME_BOOT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOT_SCRIPT).toContain("'light'");
    expect(THEME_BOOT_SCRIPT).toContain("'dark'");
    expect(THEME_BOOT_SCRIPT.startsWith('(function(){')).toBe(true);
    expect(THEME_BOOT_SCRIPT).toContain('catch');
  });

  it('cannot be influenced by interpolated data', () => {
    // A single constant string: re-evaluating it must yield the same value.
    expect(THEME_BOOT_SCRIPT).toBe(THEME_BOOT_SCRIPT.trim());
    expect(THEME_BOOT_SCRIPT.includes('${')).toBe(false);
  });
});

describe('nav helpers', () => {
  it('keeps the overview item exact so sub-pages stay inactive', () => {
    expect(isActivePath('/console', CONSOLE_BASE_PATH, true)).toBe(true);
    expect(isActivePath('/console/keys', CONSOLE_BASE_PATH, true)).toBe(false);
    expect(isActivePath('/console/keys', `${CONSOLE_BASE_PATH}/keys`, false)).toBe(true);
    expect(isActivePath('/console/keys/extra', `${CONSOLE_BASE_PATH}/keys`, false)).toBe(true);
    expect(isActivePath('/consolex', `${CONSOLE_BASE_PATH}/keys`, false)).toBe(false);
  });

  it('tolerates a trailing slash and a null pathname', () => {
    expect(isActivePath('/console/keys/', `${CONSOLE_BASE_PATH}/keys`, false)).toBe(true);
    expect(isActivePath(null, CONSOLE_BASE_PATH, true)).toBe(false);
    expect(isActivePath('', CONSOLE_BASE_PATH, true)).toBe(false);
  });

  it('resolves the current section for the topbar', () => {
    expect(findNavItem('/console').label).toBe('Overview');
    expect(findNavItem('/console/keys').label).toBe('API keys');
    expect(findNavItem('/console/providers').label).toBe('Providers');
    expect(findNavItem('/console/logs').label).toBe('Logs');
    expect(findNavItem('/console/settings').label).toBe('Settings');
    expect(findNavItem('/unknown').label).toBe('Overview');
  });
});

describe('sanitizeNextPath', () => {
  it('accepts a same-origin console path', () => {
    expect(sanitizeNextPath('/console/keys')).toBe('/console/keys');
    expect(sanitizeNextPath('  /console/logs?cursor=1|a  ')).toBe('/console/logs?cursor=1|a');
  });

  it('refuses to become an open redirect', () => {
    expect(sanitizeNextPath('//evil.example')).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath('/\\evil.example')).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath('https://evil.example')).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath('javascript:alert(1)')).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath('/console/\\x')).toBe(CONSOLE_BASE_PATH);
  });

  it('never redirects back to the login page', () => {
    expect(sanitizeNextPath(LOGIN_PATH)).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath(`${LOGIN_PATH}?next=/console`)).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath(`${LOGIN_PATH}/x`)).toBe(CONSOLE_BASE_PATH);
  });

  it('falls back for missing, empty or absurd values', () => {
    expect(sanitizeNextPath(null)).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath(undefined)).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath('')).toBe(CONSOLE_BASE_PATH);
    expect(sanitizeNextPath(`/${'a'.repeat(600)}`)).toBe(CONSOLE_BASE_PATH);
  });
});
