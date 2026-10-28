'use client';

import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ADMIN_REQUIRED_DESCRIPTION, ADMIN_REQUIRED_TITLE } from '@/components/auth/messages';

export interface UsersAccessNoticeProps {
  isGuest: boolean;
  onSignIn: () => void;
}

/**
 * What a guest or a `member` sees instead of a user list nobody would let them read.
 *
 * The notice names the reason instead of rendering an empty table, and the button
 * opens the sign-in dialog the shell already owns (C-AUTH-CONTEXT) - no redirect, so
 * a member who typed `/console/users` keeps the console around them.
 */
export function UsersAccessNotice({ isGuest, onSignIn }: UsersAccessNoticeProps): ReactNode {
  const description = isGuest
    ? 'Sign in with an administrator account to create, edit or remove console users. ' +
      'Accounts, roles and the registration switch are administrator-only.'
    : ADMIN_REQUIRED_DESCRIPTION;
  return (
    <Card className="px-6 py-10 text-center">
      <span
        className={
          'mx-auto flex h-11 w-11 items-center justify-center rounded-full ' +
          'border border-warning/40 bg-[color:var(--warning-soft)] text-warning'
        }
      >
        <ShieldAlert size={18} aria-hidden="true" />
      </span>
      <h2 className="mt-3 text-lg font-semibold leading-6 text-text">{ADMIN_REQUIRED_TITLE}</h2>
      <p role="alert" className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
        {description}
      </p>
      <div className="mt-5 flex justify-center">
        <Button variant="primary" size="md" onClick={onSignIn}>
          {isGuest ? 'Sign in' : 'Sign in with another account'}
        </Button>
      </div>
      <p className="mt-4 text-[11px] leading-4 text-muted">
        <span className="mono text-text">GET /api/admin/users</span> answers{' '}
        <span className="mono text-text">403</span> for a member account, so this page never
        requests a list it is not allowed to read.
      </p>
    </Card>
  );
}
