'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { AuthForm } from '@/components/auth/AuthForm';
import { useAuth } from '@/components/auth/auth-context';
import { REGISTER_TITLE } from '@/components/auth/messages';

const DIALOG_TITLES = {
  login: 'Welcome back',
  register: REGISTER_TITLE,
} as const;

const DIALOG_DESCRIPTIONS = {
  login: 'Sign in with your console account to load live panel data.',
  register: 'Create a member account. An administrator can promote it later.',
} as const;

/** Premium framing built only from tokens that already exist (C10). */
const PANEL_CLASS =
  'overflow-hidden border-border-strong shadow-pop ring-1 ring-[color:var(--brand-soft)]';
const GLOW_CLASS =
  'pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(60%_120%_at_50%_0%,' +
  'var(--brand-soft),transparent_70%)]';
const TRUST_CLASS =
  'mt-3 flex items-center justify-center gap-1.5 text-[11px] leading-4 text-muted';

/**
 * The console's primary sign-in surface (C-AUTH-CONTEXT).
 *
 * It is a thin host: `Modal` already owns the portal, the focus trap, Escape and
 * backdrop dismissal, `aria-modal` and the scroll lock, so this component only
 * decides *what* goes inside - the shared `AuthForm` plus the premium framing
 * (brand glow, hairline ring, trust line) built from the existing design tokens.
 *
 * While a submit is in flight the dialog stops closing, so an interrupted request
 * cannot leave the operator unsure whether the account was created.
 */
export function LoginModal(): ReactNode {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);

  const handleAuthenticated = useCallback(
    (user: Parameters<typeof auth.completeSignIn>[0]) => {
      auth.completeSignIn(user);
    },
    [auth],
  );

  const handlePending = useCallback((pending: boolean) => {
    setBusy(pending);
  }, []);

  return (
    <Modal
      open={auth.loginModalOpen}
      onClose={auth.closeLogin}
      title={DIALOG_TITLES[auth.loginMode]}
      description={DIALOG_DESCRIPTIONS[auth.loginMode]}
      size="sm"
      busy={busy}
      className={PANEL_CLASS}
    >
      {/* Decorative brand glow: the same radial used by the /login page, so the
          dialog and the fallback page read as one product. */}
      <div aria-hidden="true" className={GLOW_CLASS} />
      <div className="relative">
        <AuthForm
          mode={auth.loginMode}
          onModeChange={auth.openLogin}
          registrationEnabled={auth.registrationEnabled}
          onAuthenticated={handleAuthenticated}
          notice={auth.loginNotice}
          autoFocus
          onPendingChange={handlePending}
        />
        <p className={TRUST_CLASS}>
          <ShieldCheck size={12} aria-hidden="true" />
          <span>Session cookies are HttpOnly; credentials are verified by the server only.</span>
        </p>
      </div>
    </Modal>
  );
}
