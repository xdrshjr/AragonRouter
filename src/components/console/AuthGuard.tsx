'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { getSession, signOut } from '@/components/console/api';
import { watchSessionExpiry } from '@/components/console/session-expiry';
import { LOGIN_PATH } from '@/components/console/nav';
import { Sidebar } from '@/components/console/Sidebar';
import { Topbar } from '@/components/console/Topbar';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';

/** Build `/login?next=<path>` without ever emitting an open redirect. */
export function buildLoginRedirect(pathname: string | null | undefined): string {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return LOGIN_PATH;
  }
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}?`)) return LOGIN_PATH;
  return `${LOGIN_PATH}?next=${encodeURIComponent(pathname)}`;
}

type GuardState = 'checking' | 'authenticated' | 'anonymous';

/**
 * Client-side session gate for the console.
 *
 * The pages already refuse to render without a C3-shaped cookie (see
 * `session-gate.ts`, which covers "no session at all" and the JavaScript-disabled
 * case). This guard proves the cookie itself: C3 exposes no server-readable
 * identity, so the console calls `GET /api/admin/session` once on mount and
 * redirects to `/login` when it answers 401.
 *
 * The API is still the only authority: every page fetch re-checks the session, a
 * 401 from any admin call re-runs this redirect, and the transport layer raises a
 * global expiry signal (`session-expiry.ts`) that this guard subscribes to, so
 * mutations redirect too.
 */
export function AuthGuard({ children }: { children: ReactNode }): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<GuardState>('checking');
  const [signingOut, setSigningOut] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const toast = useToast();
  const mounted = useRef(true);
  /** The session is verified once per mount; navigation must not blank the shell. */
  const verified = useRef(false);
  /** Latest route, read by the expiry subscription (which outlives a navigation). */
  const currentPath = useRef(pathname);
  currentPath.current = pathname;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // A second verification on every navigation would unmount the shell (and the
    // page) on each click. Once the API has confirmed the cookie, later 401s are
    // caught by the expiry signal subscribed below (and, redundantly, by
    // `useSessionExpiryRedirect` on the page's own data request).
    if (verified.current) return;
    const controller = new AbortController();
    setState('checking');
    getSession(controller.signal)
      .then((ok) => {
        if (!mounted.current) return;
        if (ok) {
          verified.current = true;
          setState('authenticated');
          return;
        }
        setState('anonymous');
        router.replace(buildLoginRedirect(pathname));
      })
      .catch(() => {
        if (!mounted.current) return;
        setState('anonymous');
        router.replace(buildLoginRedirect(pathname));
      });
    return () => {
      controller.abort();
    };
  }, [pathname, router]);

  // An expired session is announced by the transport layer (`api.ts` raises the
  // signal on any 401), not by each panel: this subscription is what makes
  // 'Create key', 'Revoke', 'Add/Edit/Delete provider', the enabled toggle and
  // 'Test connection' navigate to /login instead of failing silently. Firing once
  // keeps parallel 401s from racing over the history entry.
  useEffect(() => {
    const watcher = watchSessionExpiry(() => {
      setState('anonymous');
      router.replace(buildLoginRedirect(currentPath.current));
    });
    return watcher.unsubscribe;
  }, [router]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!navOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setNavOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [navOpen]);

  const handleSignOut = useCallback(() => {
    setSigningOut(true);
    signOut()
      .catch(() => {
        // A failed DELETE still means the UI must leave the protected area; the
        // cookie may already be gone or the server may be restarting.
      })
      .finally(() => {
        if (!mounted.current) return;
        setSigningOut(false);
        toast.push({ title: 'Signed out', tone: 'success' });
        router.replace(LOGIN_PATH);
      });
  }, [router, toast]);

  if (state !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
          <Spinner size={16} label={null} />
          <span>{state === 'checking' ? 'Checking your session' : 'Redirecting to sign in'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg">
      <a href="#console-main" className="skip-link">
        Skip to content
      </a>

      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn('fixed inset-0 z-40 lg:hidden', navOpen ? '' : 'pointer-events-none')}
        aria-hidden={navOpen ? undefined : true}
      >
        <div
          onClick={() => {
            setNavOpen(false);
          }}
          className={cn(
            'absolute inset-0 bg-[color:var(--overlay)] transition-opacity duration-150',
            navOpen ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          role="dialog"
          aria-modal={navOpen || undefined}
          aria-label="Console navigation"
          className={cn(
            'absolute inset-y-0 left-0 w-64 border-r border-border bg-surface shadow-pop transition-transform duration-200 ease-console',
            navOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar
            onNavigate={() => {
              setNavOpen(false);
            }}
          />
        </div>
      </div>

      <div className="lg:pl-56">
        <Topbar
          pathname={pathname}
          onOpenNav={() => {
            setNavOpen(true);
          }}
          onSignOut={handleSignOut}
          signingOut={signingOut}
        />
        <main id="console-main" className="mx-auto w-full max-w-console px-4 py-6 sm:px-6">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-console px-4 pb-8 sm:px-6">
          <p className="border-t border-border pt-4 text-[11px] leading-4 text-muted">
            AragonRouter relays requests to your configured upstreams. Credentials are encrypted at
            rest and never returned by this console.
          </p>
        </footer>
      </div>
    </div>
  );
}

/**
 * Redirect to `/login` when a given error reports 401.
 *
 * The primary path is now the transport-level signal (`session-expiry.ts`), which
 * `AuthGuard` subscribes to and which covers queries and mutations alike. This hook
 * is the per-error fallback: a page hands it the error it already holds, so the
 * redirect also works where the shell is not mounted (and stays obvious in tests).
 */
export function useSessionExpiryRedirect(error: { status: number } | null): void {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!error || error.status !== 401) return;
    router.replace(buildLoginRedirect(pathname));
  }, [error, pathname, router]);
}
