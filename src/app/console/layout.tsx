import type { Metadata } from 'next';
import { AuthGuard } from '@/components/console/AuthGuard';
import { ToastProvider } from '@/components/ui/Toast';
import { requireSession } from '@/components/console/session-gate';

export const metadata: Metadata = {
  title: 'Console',
};

/**
 * Console shell. Everything under `/console` is client-rendered against the admin
 * API, so the shell only gates the session, mounts the toast host and the guard.
 *
 * The session itself lives in an HttpOnly cookie (C3): the browser cannot read it
 * and the UI therefore never tries. `requireSession` rejects a request that carries
 * no C3-shaped cookie before any markup is produced, and `AuthGuard` then proves
 * the cookie against `GET /api/admin/session` (the API stays the only authority).
 *
 * The gate runs in the layout rather than in each page so that it completes before
 * the client shell starts streaming - a page-level redirect would be delivered as a
 * soft (in-band) redirect because the layout had already been flushed.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await requireSession('/console');
  return (
    <ToastProvider>
      <AuthGuard>{children}</AuthGuard>
    </ToastProvider>
  );
}
