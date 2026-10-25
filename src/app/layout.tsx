import type { Metadata, Viewport } from 'next';
import { THEME_BOOT_SCRIPT } from '@/components/console/theme';
import './globals.css';

/**
 * Root layout for the whole application.
 *
 * Two details matter:
 *  - `className="dark"` on `<html>` matches the dark C10 palette in `:root`, so the
 *    very first paint is dark even before the inline boot script runs;
 *  - the boot script reads `localStorage` and applies the stored theme *before*
 *    the body is parsed, which is what removes the light/dark flash on reload.
 * No `next/font` is used: C10 mandates the system font stack.
 *
 * Icons are produced by the App Router *file convention* only - no `icons` object is
 * declared below on purpose. A config `icons` value replaces the file-convention
 * links instead of merging with them (`resolve-metadata.js` only unshifts the
 * file-based icons when `metadata.icons` is unset), which would drop the
 * content-hashed favicon URL and force a second, hand-written copy of every entry.
 * The convention gives us both links for free:
 *  - `src/app/icon.svg`       -> `<link rel="icon" type="image/svg+xml">`
 *  - `src/app/apple-icon.png` -> `<link rel="apple-touch-icon" sizes="180x180">`
 *    Next routes only `apple-icon.{jpg,jpeg,png}` for the iOS tile (SVG is not in
 *    `STATIC_METADATA_IMAGES.apple`), so the tile is a PNG rasterised from the
 *    180x180 vector master `src/app/apple-icon.svg` by
 *    `src/components/brand/generate-apple-icon.mjs`.
 */
export const metadata: Metadata = {
  title: {
    default: 'AragonRouter console',
    template: '%s · AragonRouter',
  },
  description:
    'Admin console for AragonRouter: relay API keys, upstream providers, request logs and usage.',
  applicationName: 'AragonRouter',
  /**
   * iOS standalone hints. `capable: true` emits
   * `<meta name="mobile-web-app-capable" content="yes">` plus the
   * `apple-mobile-web-app-title` / `-status-bar-style` tags; the home-screen tile
   * itself comes from the `apple-icon.png` file convention (see the doc block above).
   */
  appleWebApp: {
    capable: true,
    title: 'AragonRouter',
    statusBarStyle: 'black-translucent',
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#121212',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Anti-flash: runs before the body renders. Constant string, no interpolation. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
          suppressHydrationWarning
        />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">{children}</body>
    </html>
  );
}
