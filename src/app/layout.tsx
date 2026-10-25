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
 */
export const metadata: Metadata = {
  title: {
    default: 'AragonRouter console',
    template: '%s · AragonRouter',
  },
  description:
    'Admin console for AragonRouter: relay API keys, upstream providers, request logs and usage.',
  applicationName: 'AragonRouter',
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
