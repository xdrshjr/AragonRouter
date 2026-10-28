'use client';

import { createContext, useContext } from 'react';
import type { AuthMode, UserPublic } from '@/components/console/types';
import type { AuthStatus } from '@/components/auth/auth-machine';

/**
 * The auth context value (C-AUTH-CONTEXT).
 *
 * Declared in its own module so `useAuth` can be imported by any component -
 * including the dialog that `AuthProvider` itself mounts - without a circular
 * import, and so `AuthProvider.tsx` can re-export it as the contract requires.
 */
export interface AuthContextValue {
  /** `loading` until the first `GET /api/auth/session` answers. */
  status: AuthStatus;
  user: UserPublic | null;
  /** C-AUTH-WIRE `registration.enabled`, known before anybody signs in. */
  registrationEnabled: boolean;
  isAdmin: boolean;
  isGuest: boolean;
  /** Which tab the next `openLogin()` shows. */
  loginMode: AuthMode;
  loginModalOpen: boolean;
  /** Announcement shown inside the dialog (e.g. "your session expired"). */
  loginNotice: string | null;
  openLogin: (mode?: AuthMode, notice?: string | null) => void;
  closeLogin: () => void;
  /** `POST /api/auth/logout`, then back to the guest shell. */
  signOut: () => Promise<void>;
  /** Re-read the session (used after an expiry and after a settings change). */
  refresh: () => Promise<void>;
  /**
   * Adopt the account the server just returned from `/api/auth/login` or
   * `/api/auth/register`. Saves a round-trip; `refresh()` stays the authority.
   */
  completeSignIn: (user: UserPublic) => void;
}

/**
 * No provider: behave like a guest with no-op actions.
 *
 * This mirrors `useToast`, and it exists for one reason: a panel rendered in
 * isolation (a static render, a component test) must not crash. The real
 * application always mounts `AuthProvider` in the console layout and on `/login`.
 */
const DETACHED: AuthContextValue = {
  status: 'guest',
  user: null,
  registrationEnabled: false,
  isAdmin: false,
  isGuest: true,
  loginMode: 'login',
  loginModalOpen: false,
  loginNotice: null,
  openLogin: () => undefined,
  closeLogin: () => undefined,
  signOut: async () => undefined,
  refresh: async () => undefined,
  completeSignIn: () => undefined,
};

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Identity of the current console user; see {@link AuthContextValue}. */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext) ?? DETACHED;
}

/**
 * Same value, but `null` when nothing is mounted.
 *
 * Used by the expiry hook that panels call: redirecting (or opening a dialog) is
 * meaningless without a provider, and silently doing nothing is the right answer
 * there rather than throwing inside a data-fetching component.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
