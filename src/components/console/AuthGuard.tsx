'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth, useOptionalAuth } from '@/components/auth/auth-context';
import { AdminRequiredMask, GuestMask } from '@/components/auth/AccessMasks';
import { SESSION_EXPIRED_NOTICE } from '@/components/auth/messages';
import type { AuthStatus } from '@/components/auth/auth-machine';
import type { UserPublic } from '@/components/console/types';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { subscribeSessionExpired } from '@/components/console/session-expiry';
import { buildLoginHref } from '@/components/console/session-gate';
import { Sidebar } from '@/components/console/Sidebar';
import { Topbar } from '@/components/console/Topbar';

export interface AuthGuardProps {
  children: ReactNode;
}

/** Fixed desktop navigation rail. */
const RAIL_CLASS = 'fixed inset-y-0 left-0 z-20 hidden w-56 border-r border-border bg-surface lg:block';

/**
 * Console shell for **everybody** (guest-first, C-AUTH-CONTEXT).
 *
 * The previous version proved the cookie and redirected to `/login`; the product
 * decision retired that: a visitor may walk into `/console` and `/console/keys`,
 * see the sidebar, the top bar and the page frame, and is only asked to sign in for
 * the panel data. So the shell renders in all three states:
 *
 *  - `loading`  - skeleton while `GET /api/auth/session` is in flight;
 *  - `guest`    - shell + sign-in mask, and **`children` are not mounted**, so no
 *                 panel ever issues an admin request;
 *  - `authenticated` - `admin` gets the panels; a `member` gets the
 *                 "administrator access required" mask, because every console
 *                 endpoint answers 403 for that role.
 *
 * Expiry is still detected at the transport layer (`api.ts` raises the signal on
 * any `/api/admin/**` 401). Instead of navigating, the shell returns to the guest
 * view and opens the dialog, so the operator keeps their place in the console.
 */
export function AuthGuard({ children }: AuthGuardProps): ReactNode {
  const auth = useAuth();
  const pathname = usePathname();
  const toast = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /** Latest context, read by the long-lived expiry subscription. */
  const latest = useRef(auth);
  latest.current = auth;
  /** Coalesces a burst of parallel 401s into one probe. */
  const probing = useRef(false);

  // Any admin 401: back to the guest view (the probe re-reads the truth) plus the
  // dialog, so nothing silently stops working. No navigation, no lost location.
  useEffect(() => {
    return subscribeSessionExpired(() => {
      const current = latest.current;
      current.openLogin('login', SESSION_EXPIRED_NOTICE);
      if (probing.current) return;
      probing.current = true;
      void current.refresh().finally(() => {
        probing.current = false;
      });
    });
  }, []);

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

  /**
   * A guest clicking any navigation entry is asking for panel data, so the shell
   * answers with the dialog instead of a navigation that would land on the same
   * mask. Keyboard activation fires a click too, so this covers both. The sidebar
   * itself belongs to another work package and stays untouched.
   */
  const guardNavigation = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!auth.isGuest) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('a')) return;
      event.preventDefault();
      event.stopPropagation();
      auth.openLogin('login');
    },
    [auth],
  );

  const handleSignOut = useCallback(() => {
    setSigningOut(true);
    void auth
      .signOut()
      .catch(() => {
        // `signOut` already tolerates transport failures; only the toast is left.
      })
      .finally(() => {
        setSigningOut(false);
        toast.push({ title: 'Signed out', tone: 'success' });
      });
  }, [auth, toast]);

  return (
    <div className="min-h-screen bg-bg">
      <a href="#console-main" className="skip-link">
        Skip to content
      </a>

      {/* Desktop rail */}
      <aside className={RAIL_CLASS}>
        <div onClick={guardNavigation}>
          <Sidebar />
        </div>
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
            'absolute inset-y-0 left-0 w-64 border-r border-border bg-surface shadow-pop',
            'transition-transform duration-200 ease-console',
            navOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div onClick={guardNavigation}>
            <Sidebar
              onNavigate={() => {
                setNavOpen(false);
              }}
            />
          </div>
        </div>
      </div>

      <div className="lg:pl-56">
        <Topbar
          pathname={pathname}
          onOpenNav={() => {
            setNavOpen(true);
          }}
        />
        <main id="console-main" className="mx-auto w-full max-w-console px-4 py-6 sm:px-6">
          <ConsoleBody
            status={auth.status}
            isGuest={auth.isGuest}
            isAdmin={auth.isAdmin}
            user={auth.user}
            registrationEnabled={auth.registrationEnabled}
            loginHref={buildLoginHref(pathname)}
            onSignIn={() => {
              auth.openLogin('login');
            }}
            onRegister={() => {
              auth.openLogin('register');
            }}
            onSignOut={handleSignOut}
            signingOut={signingOut}
          >
            {children}
          </ConsoleBody>
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

interface ConsoleBodyProps {
  status: AuthStatus;
  isGuest: boolean;
  isAdmin: boolean;
  user: UserPublic | null;
  registrationEnabled: boolean;
  loginHref: string;
  onSignIn: () => void;
  onRegister: () => void;
  onSignOut: () => void;
  signingOut: boolean;
  children: ReactNode;
}

/**
 * The main area: skeleton, mask or the actual page.
 *
 * Kept as its own component so the shell above stays a layout description and the
 * rule "a guest never mounts the panels" is visible in one place.
 */
function ConsoleBody({
  status,
  isGuest,
  isAdmin,
  user,
  registrationEnabled,
  loginHref,
  onSignIn,
  onRegister,
  onSignOut,
  signingOut,
  children,
}: ConsoleBodyProps): ReactNode {
  if (status === 'loading') {
    return (
      <div role="status" aria-live="polite">
        <LoadingBlock label="Checking your session" />
      </div>
    );
  }
  if (isGuest) {
    return (
      <GuestMask
        onSignIn={onSignIn}
        onRegister={onRegister}
        registrationEnabled={registrationEnabled}
        loginHref={loginHref}
      />
    );
  }
  if (!isAdmin) {
    return (
      <AdminRequiredMask user={user} onSignOut={onSignOut} signingOut={signingOut} />
    );
  }
  return <>{children}</>;
}

/**
 * Fallback hook for a panel that holds a 401 error object.
 *
 * The authoritative path is the transport-level signal above, which fires for
 * queries and mutations alike. This hook keeps the per-error behaviour that panels
 * already call: the same one-shot decision, but expressed as "open the dialog"
 * instead of "navigate to /login" - the shell must not throw away the location the
 * operator was working in. Outside a provider it does nothing.
 */
export function useSessionExpiryRedirect(error: { status: number } | null): void {
  const auth = useOptionalAuth();
  const openLogin = auth?.openLogin;

  useEffect(() => {
    if (!error || error.status !== 401 || !openLogin) return;
    openLogin('login', SESSION_EXPIRED_NOTICE);
  }, [error, openLogin]);
}
