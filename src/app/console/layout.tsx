import type { Metadata } from 'next';
import { AuthGuard } from '@/components/console/AuthGuard';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { ToastProvider } from '@/components/ui/Toast';

export const metadata: Metadata = {
  title: 'Console',
};

/**
 * Console shell.
 *
 * Guest first: this layout no longer gates anything. It mounts the toast host, the
 * authentication provider (one `GET /api/auth/session` probe for the whole shell)
 * and the guard, which renders the same sidebar/top bar/footer for a guest and only
 * replaces the panel area with a sign-in mask.
 *
 * The session itself lives in an HttpOnly cookie: the browser cannot read it, so
 * the client context is the only identity source and the API remains the only
 * authority. Because nothing redirects here, `/console` and every sub-page answer
 * 200 for a visitor without a session - which is exactly the product decision.
 */
export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <ToastProvider>
      <AuthProvider>
        <AuthGuard>{children}</AuthGuard>
      </AuthProvider>
    </ToastProvider>
  );
}
