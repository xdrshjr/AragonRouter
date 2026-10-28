'use client';

import { useCallback, useState } from 'react';
import { LogIn, LogOut, Menu } from 'lucide-react';
import { BrandMark } from '@/components/brand/BrandMark';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { ThemeToggle } from '@/components/console/ThemeToggle';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/components/auth/auth-context';
import { findNavItem } from '@/components/console/nav';

/** Sticky header bar; solid so the account area stays legible over the content. */
const HEADER_CLASS =
  'sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg px-4';

export interface TopbarProps {
  pathname: string | null;
  /** Opens the mobile navigation drawer. */
  onOpenNav: () => void;
}

/**
 * Sticky page header: mobile nav trigger, current section title, theme switch and
 * the account area.
 *
 * The account area is the shell's identity readout (C-AUTH-CONTEXT): a guest gets a
 * single "Sign in" button that opens the dialog, a signed-in account gets its
 * display name, username and role plus the sign-out action. It owns no data
 * fetching - `useAuth()` is the single source, so signing in refreshes the header
 * without a second session request.
 */
export function Topbar({ pathname, onOpenNav }: TopbarProps): React.ReactNode {
  const item = findNavItem(pathname);
  const auth = useAuth();
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(() => {
    setSigningOut(true);
    void auth
      .signOut()
      .catch(() => {
        // `signOut` already swallows transport failures; this only guards the toast.
      })
      .finally(() => {
        setSigningOut(false);
        toast.push({ title: 'Signed out', tone: 'success' });
      });
  }, [auth, toast]);

  return (
    <header className={HEADER_CLASS}>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onOpenNav}
          aria-label="Open navigation"
        >
          <Menu size={18} aria-hidden="true" />
        </Button>
        {/* Product mark at the far left of the header. The rail repeats it on
            desktop, but the identity has to survive the collapsed layout too. */}
        <span className="flex shrink-0 items-center">
          <BrandMark size={20} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-5 text-text">{item.label}</h1>
          <p className="hidden truncate text-[11px] leading-4 text-muted sm:block">{item.hint}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        {auth.status === 'loading' ? (
          <span className="flex items-center gap-1.5 text-xs leading-5 text-muted">
            <Spinner size={12} label={null} />
            <span className="sr-only">Checking your session</span>
          </span>
        ) : auth.status === 'authenticated' && auth.user ? (
          <>
            <div className="hidden min-w-0 items-center gap-2 sm:flex">
              <span className="truncate text-xs font-medium leading-5 text-text">
                {auth.user.displayName ?? auth.user.username}
              </span>
              <Badge tone={auth.user.role === 'admin' ? 'brand' : 'neutral'}>
                {auth.user.role}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSignOut}
              loading={signingOut}
              loadingLabel="Signing out"
              leftIcon={<LogOut size={14} aria-hidden="true" />}
            >
              Sign out
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              auth.openLogin('login');
            }}
            leftIcon={<LogIn size={14} aria-hidden="true" />}
          >
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
