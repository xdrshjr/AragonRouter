import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration for the AragonRouter console (C10 design tokens).
 *
 * Every colour resolves to a CSS custom property declared in
 * `src/app/globals.css`, so a single `.light` class on `<html>` flips the whole
 * console between the dark (default) and light palettes without duplicating
 * utility classes. `darkMode` stays class-based because the orchestrator drives
 * the theme with `class="dark"` on `<html>` plus an anti-flash inline script.
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        /** Page background (C10 `--bg`). */
        bg: 'var(--bg)',
        /** Card / panel background (C10 `--surface`). */
        surface: 'var(--surface)',
        /** Nested / hover background (C10 `--surface-2`). */
        'surface-2': 'var(--surface-2)',
        /** Default 1px hairline (C10 `--border`). */
        border: 'var(--border)',
        /** Emphasised hairline (C10 `--border-strong`). */
        'border-strong': 'var(--border-strong)',
        /** Primary foreground (C10 `--text`). */
        text: 'var(--text)',
        /** Secondary foreground (C10 `--text-muted`). */
        muted: 'var(--text-muted)',
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
        },
        'on-brand': 'var(--on-brand)',
        danger: 'var(--danger)',
        warning: 'var(--warning)',
        info: 'var(--info)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      divideColor: {
        DEFAULT: 'var(--border)',
      },
      ringColor: {
        DEFAULT: 'var(--brand)',
      },
      caretColor: {
        DEFAULT: 'var(--brand)',
      },
      fontFamily: {
        // C10: system font stack only - no next/font, no web fonts.
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          '"Liberation Mono"',
          'monospace',
        ],
      },
      fontSize: {
        // C10: 11px uppercase section labels, 13-14px body copy.
        '2xs': ['11px', { lineHeight: '16px', letterSpacing: '0.08em' }],
        xs: ['12px', { lineHeight: '18px' }],
        sm: ['13px', { lineHeight: '20px' }],
        base: ['14px', { lineHeight: '22px' }],
        lg: ['16px', { lineHeight: '24px' }],
        xl: ['20px', { lineHeight: '28px', letterSpacing: '-0.01em' }],
        '2xl': ['24px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        // C10: 6px controls, 8px cards.
        DEFAULT: '6px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        card: '8px',
        xl: '10px',
      },
      spacing: {
        18: '4.5rem',
        22: '5.5rem',
      },
      maxWidth: {
        console: '1200px',
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255, 255, 255, 0.03) inset, 0 12px 32px -24px rgba(0, 0, 0, 0.9)',
        pop: '0 24px 64px -24px rgba(0, 0, 0, 0.75)',
        focus: '0 0 0 3px rgba(62, 207, 142, 0.24)',
      },
      backgroundImage: {
        'dot-grid': 'radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0)',
      },
      backgroundSize: {
        'dot-grid': '22px 22px',
      },
      transitionTimingFunction: {
        console: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'stroke-dash': {
          from: { strokeDashoffset: '1' },
          to: { strokeDashoffset: '0' },
        },
        shimmer: {
          '0%': { opacity: '0.35' },
          '50%': { opacity: '0.75' },
          '100%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out both',
        'scale-in': 'scale-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
