'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  persistTheme,
  readStoredTheme,
} from '@/components/console/theme';
import type { ThemeName } from '@/components/console/types';

/**
 * Dark/light switch (C10: dark is the default).
 *
 * The initial state is `dark`, which matches the class the server renders and the
 * boot script in `src/app/layout.tsx`. Reading `localStorage` happens in an effect
 * so the first client render equals the server HTML and hydration stays silent.
 */
export function ThemeToggle({ className }: { className?: string }): ReactNode {
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = readStoredTheme(typeof window === 'undefined' ? null : window.localStorage);
    setTheme(stored);
    applyTheme(document.documentElement, stored);
    setMounted(true);
  }, []);

  // Another tab changed the theme: follow it.
  useEffect(() => {
    function onStorage(event: StorageEvent): void {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      const stored = readStoredTheme(window.localStorage);
      setTheme(stored);
      applyTheme(document.documentElement, stored);
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const target = nextTheme(current);
      applyTheme(document.documentElement, target);
      persistTheme(window.localStorage, target);
      return target;
    });
  }, []);

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={theme === 'light'}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-2 text-muted',
        'transition-colors duration-150 ease-console hover:border-border-strong hover:text-text',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        className,
      )}
    >
      {theme === 'dark' ? (
        <Moon size={16} aria-hidden="true" />
      ) : (
        <Sun size={16} aria-hidden="true" />
      )}
      <span className="sr-only">{mounted ? `Current theme: ${theme}. ${label}.` : label}</span>
    </button>
  );
}
