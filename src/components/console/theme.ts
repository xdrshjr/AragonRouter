/**
 * Theme handling (C10: dark is the default palette, light is opt-in).
 *
 * The chosen theme is persisted in `localStorage` under {@link THEME_STORAGE_KEY}
 * and applied as `class="dark"` / `class="light"` on `<html>`. `:root` in
 * globals.css already carries the dark palette, so a browser with JavaScript
 * disabled still gets the dark console.
 */

import type { ThemeName } from '@/components/console/types';

/** localStorage key shared by the toggle and the anti-flash boot script. */
export const THEME_STORAGE_KEY = 'aragon-theme';

/** C10: dark is the default, including when nothing is stored. */
export const DEFAULT_THEME: ThemeName = 'dark';

/** Resolve a persisted value. Anything unexpected falls back to dark. */
export function resolveTheme(stored: unknown): ThemeName {
  return stored === 'light' ? 'light' : DEFAULT_THEME;
}

/** The `<html>` class for a theme. */
export function themeClassName(theme: ThemeName): ThemeName {
  return theme === 'light' ? 'light' : 'dark';
}

/** The class to toggle to. */
export function nextTheme(theme: ThemeName): ThemeName {
  return theme === 'light' ? 'dark' : 'light';
}

/** Read the persisted theme without ever throwing (Safari private mode, disabled storage). */
export function readStoredTheme(storage: Pick<Storage, 'getItem'> | null | undefined): ThemeName {
  if (!storage) return DEFAULT_THEME;
  try {
    return resolveTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the theme, ignoring quota/permission failures. */
export function persistTheme(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  theme: ThemeName,
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A console that cannot remember the theme still works; never break the click.
  }
}

export interface ThemeTarget {
  classList: { add: (...tokens: string[]) => void; remove: (...tokens: string[]) => void };
}

/** Apply the theme to an element (normally `document.documentElement`). */
export function applyTheme(target: ThemeTarget | null | undefined, theme: ThemeName): void {
  if (!target) return;
  const className = themeClassName(theme);
  target.classList.remove('dark', 'light');
  target.classList.add(className);
}

/**
 * Inline script injected into `<head>` before the first paint.
 *
 * It reads the persisted theme and sets the class immediately, which is what
 * prevents a dark->light flash. It is a constant string with no interpolation,
 * so it cannot be influenced by stored data beyond the two literal class names;
 * every access is guarded in case storage throws.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=window.localStorage.getItem('${THEME_STORAGE_KEY}');var d=document.documentElement;if(s==='light'){d.classList.remove('dark');d.classList.add('light');}else{d.classList.remove('light');d.classList.add('dark');}}catch(e){document.documentElement.classList.remove('light');document.documentElement.classList.add('dark');}})();`;
