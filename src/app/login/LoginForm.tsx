'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { ThemeToggle } from '@/components/console/ThemeToggle';
import { AuthForm } from '@/components/auth/AuthForm';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { useAuth } from '@/components/auth/auth-context';
import { SESSION_EXPIRED_NOTICE } from '@/components/auth/messages';
import type { AuthMode } from '@/components/console/types';

export interface LoginFormProps {
  /** Already-sanitised redirect target (same-origin path). */
  nextPath: string;
  /** True when the request still carried a session-shaped cookie. */
  sessionExpiredHint?: boolean;
}

/**
 * The `/login` fallback page.
 *
 * It is the same form the console dialog uses (`AuthForm`) inside a card, wrapped
 * in the same `AuthProvider` the console mounts - so the registration switch comes
 * from `GET /api/auth/session`, and a visitor who is already signed in is sent on
 * to `next` instead of being asked for a password again.
 *
 * Nothing here redirects the *shell*: this page is reachable directly, and after a
 * successful sign-in it navigates to the sanitised `next` target and refreshes so
 * the server components see the new cookie.
 */
export function LoginForm({ nextPath, sessionExpiredHint = false }: LoginFormProps): ReactNode {
  return (
    <AuthProvider>
      <LoginCard nextPath={nextPath} sessionExpiredHint={sessionExpiredHint} />
    </AuthProvider>
  );
}

function LoginCard({ nextPath, sessionExpiredHint }: LoginFormProps): ReactNode {
  const auth = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>('login');

  const leave = useCallback(() => {
    router.replace(nextPath);
    router.refresh();
  }, [nextPath, router]);

  // Already signed in (a stale bookmark, or a second tab): skip the form.
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    leave();
  }, [auth.status, leave]);

  const notice = useMemo(() => {
    if (sessionExpiredHint) return SESSION_EXPIRED_NOTICE;
    return null;
  }, [sessionExpiredHint]);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold leading-6 text-text">
            {auth.status === 'authenticated' ? 'Signed in' : 'Account'}
          </h1>
          <p className="mt-1 text-xs leading-5 text-muted">
            {auth.status === 'authenticated'
              ? 'Redirecting you to the console.'
              : 'Sign in, or create a member account.'}
          </p>
        </div>
        <ThemeToggle />
      </div>

      {auth.status === 'authenticated' ? (
        <p role="status" className="text-xs leading-5 text-muted">
          Taking you back to {nextPath}.
        </p>
      ) : (
        <AuthForm
          mode={mode}
          onModeChange={setMode}
          registrationEnabled={auth.registrationEnabled}
          onAuthenticated={leave}
          notice={notice}
        />
      )}
    </Card>
  );
}
