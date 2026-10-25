'use client';

import { LogOut, Menu } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/console/ThemeToggle';
import { findNavItem } from '@/components/console/nav';

export interface TopbarProps {
  pathname: string | null;
  /** Opens the mobile navigation drawer. */
  onOpenNav: () => void;
  onSignOut: () => void;
  /** True while the logout request is in flight. */
  signingOut?: boolean;
}

/**
 * Sticky page header: mobile nav trigger, current section title, theme switch and
 * the sign-out action. It deliberately owns no data fetching.
 */
export function Topbar({ pathname, onOpenNav, onSignOut, signingOut = false }: TopbarProps): React.ReactNode {
  const item = findNavItem(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur-md">
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
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-5 text-text">{item.label}</h1>
          <p className="hidden truncate text-[11px] leading-4 text-muted sm:block">{item.hint}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          loading={signingOut}
          loadingLabel="Signing out"
          leftIcon={<LogOut size={14} aria-hidden="true" />}
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}
