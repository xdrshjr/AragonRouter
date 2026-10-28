'use client';

import type { ReactNode } from 'react';
import { Lock, LogIn, ShieldAlert, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import {
  ADMIN_REQUIRED_DESCRIPTION,
  ADMIN_REQUIRED_TITLE,
  GUEST_MASK_ACTION,
  GUEST_MASK_DESCRIPTION,
  GUEST_MASK_REGISTER_ACTION,
  GUEST_MASK_TITLE,
} from '@/components/auth/messages';
import type { UserPublic } from '@/components/console/types';

/** The brand glow both masks share (same radial the /login page paints). */
const GLOW_CLASS =
  'pointer-events-none absolute inset-x-0 top-0 bg-[radial-gradient(60%_120%_at_50%_0%,' +
  'var(--brand-soft),transparent_70%)]';
/** Round icon badge above a mask headline. */
const BADGE_CLASS =
  'mx-auto flex h-11 w-11 items-center justify-center rounded-full border';

export interface GuestMaskProps {
  /** Opens the sign-in dialog. */
  onSignIn: () => void;
  /** Opens the dialog on the register tab (omitted while sign-ups are closed). */
  onRegister?: () => void;
  registrationEnabled?: boolean;
  /**
   * `/login?next=<current path>` - the deep-link fallback for visitors who want a
   * full page instead of the dialog (or who will bookmark the sign-in page).
   */
  loginHref?: string;
}

/**
 * What a guest sees where the panel content would be.
 *
 * The shell around it (sidebar, top bar, footer) stays mounted and navigable: the
 * product decision is "guests may look around the console, panel data needs an
 * account". Clicking the card opens the dialog, and the card also carries a real
 * button so the same action is reachable with the keyboard; `children` are never
 * mounted for a guest, so no panel ever fires an admin request.
 */
export function GuestMask({
  onSignIn,
  onRegister,
  registrationEnabled = false,
  loginHref,
}: GuestMaskProps): ReactNode {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className={cn(GLOW_CLASS, 'h-40')}
      />
      <Card
        interactive
        onClick={onSignIn}
        className="relative cursor-pointer px-6 py-10 text-center"
      >
        <span
          className={cn(BADGE_CLASS, 'border-brand/40 bg-[color:var(--brand-soft)] text-brand')}
        >
          <Lock size={18} aria-hidden="true" />
        </span>
        <h2 className="mt-3 text-lg font-semibold leading-6 text-text">{GUEST_MASK_TITLE}</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
          {GUEST_MASK_DESCRIPTION}
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="primary"
            size="lg"
            onClick={(event) => {
              event.stopPropagation();
              onSignIn();
            }}
            leftIcon={<LogIn size={14} aria-hidden="true" />}
          >
            {GUEST_MASK_ACTION}
          </Button>
          {registrationEnabled && onRegister ? (
            <Button
              variant="secondary"
              size="lg"
              onClick={(event) => {
                event.stopPropagation();
                onRegister();
              }}
              leftIcon={<UserPlus size={14} aria-hidden="true" />}
            >
              {GUEST_MASK_REGISTER_ACTION}
            </Button>
          ) : null}
        </div>

        <p className="mt-5 text-[11px] leading-4 text-muted">
          Browsing the shell is open to everyone. No panel data is requested until you sign in.
          {loginHref ? (
            <>
              {' '}
              <a href={loginHref} className="text-brand underline-offset-2 hover:underline">
                Open the full sign-in page
              </a>
            </>
          ) : null}
        </p>
      </Card>
    </div>
  );
}

export interface AdminRequiredMaskProps {
  /** The signed-in member account (null only in a detached render). */
  user: UserPublic | null;
  onSignOut: () => void;
  signingOut?: boolean;
}

/**
 * What a signed-in `member` sees where the panel content would be.
 *
 * Every console endpoint is admin-only (`withAdmin` answers 403), so mounting the
 * panels for a member would render five broken screens and a pile of 403s. The
 * shell stays, the person is told what is missing, and the two ways forward
 * (sign out, or wait for a promotion and refresh) are both available.
 */
export function AdminRequiredMask({
  user,
  onSignOut,
  signingOut = false,
}: AdminRequiredMaskProps): ReactNode {
  return (
    <Card className="px-6 py-10 text-center">
      <span
        className={cn(BADGE_CLASS, 'border-warning/40 bg-[color:var(--warning-soft)] text-warning')}
      >
        <ShieldAlert size={18} aria-hidden="true" />
      </span>
      <h2 className="mt-3 text-lg font-semibold leading-6 text-text">{ADMIN_REQUIRED_TITLE}</h2>
      <p role="alert" className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
        {ADMIN_REQUIRED_DESCRIPTION}
      </p>
      {user ? (
        <p className="mt-3 flex items-center justify-center gap-2 text-xs leading-5 text-muted">
          <span className="mono">{user.username}</span>
          <Badge tone="neutral">{user.role}</Badge>
        </p>
      ) : null}
      <div className="mt-5 flex justify-center">
        <Button
          variant="secondary"
          onClick={onSignOut}
          loading={signingOut}
          loadingLabel="Signing out"
        >
          Sign out
        </Button>
      </div>
    </Card>
  );
}
