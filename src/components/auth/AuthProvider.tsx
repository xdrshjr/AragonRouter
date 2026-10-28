'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { fetchAuthState, isAbortError, logout } from '@/components/console/api';
import {
  authReducer,
  initialAuthSnapshot,
  isAdminSnapshot,
  isGuestSnapshot,
  resolveAuthMode,
  type AuthSnapshot,
} from '@/components/auth/auth-machine';
import { AuthContext, type AuthContextValue } from '@/components/auth/auth-context';
import { LoginModal } from '@/components/auth/LoginModal';
import type { AuthMode, UserPublic } from '@/components/console/types';

export interface AuthProviderProps {
  children: ReactNode;
  /**
   * State to start from. The default is `loading`, which is what a real page wants:
   * the shell shows a skeleton until the server has answered. Tests (and server
   * renders of a fixed state) can pin `guest` / `authenticated` instead.
   */
  initialState?: Partial<AuthSnapshot>;
}

/**
 * Client-side authentication context (C-AUTH-CONTEXT).
 *
 * One probe on mount - `GET /api/auth/session`, which answers 200 for guests too -
 * tells the shell who is signed in and whether sign-ups are open. From then on the
 * context is the single identity source: `AuthGuard`, `Topbar`, the panels and the
 * sign-in dialog all read it instead of each fetching the session again.
 *
 * The dialog is mounted here rather than in a page, so `openLogin()` works from any
 * protected entry point in the shell.
 */
export function AuthProvider({ children, initialState }: AuthProviderProps): ReactNode {
  const [snapshot, dispatch] = useReducer(
    authReducer,
    initialState,
    (seed): AuthSnapshot => ({ ...initialAuthSnapshot, ...seed }),
  );

  const mounted = useRef(true);
  const probe = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      probe.current?.abort();
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    probe.current?.abort();
    const current = new AbortController();
    probe.current = current;
    dispatch({ type: 'session-loading' });
    try {
      const state = await fetchAuthState(current.signal);
      if (!mounted.current || current.signal.aborted) return;
      dispatch({
        type: 'session-loaded',
        user: state.user,
        registrationEnabled: state.registration.enabled,
      });
    } catch (error) {
      if (!mounted.current || current.signal.aborted || isAbortError(error)) return;
      // A dead API must not leave the shell claiming a session it cannot prove.
      const message =
        error instanceof Error ? error.message : 'The session could not be read.';
      dispatch({ type: 'session-unavailable', message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openLogin = useCallback((mode?: AuthMode, notice?: string | null) => {
    dispatch({ type: 'open-login', mode, notice });
  }, []);

  const closeLogin = useCallback(() => {
    dispatch({ type: 'close-login' });
  }, []);

  const completeSignIn = useCallback((user: UserPublic) => {
    dispatch({ type: 'authenticated', user });
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      // The route revokes the session row and clears the cookie; it answers 200 for
      // a guest too, so this never turns a deliberate sign-out into an error.
      await logout();
    } catch {
      // A failed POST still has to leave the protected area: the cookie may already
      // be gone (or the server may be restarting), and the probe below re-reads the
      // real state either way.
    } finally {
      if (mounted.current) {
        dispatch({ type: 'signed-out' });
        void refresh();
      }
    }
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: snapshot.status,
      user: snapshot.user,
      registrationEnabled: snapshot.registrationEnabled,
      isAdmin: isAdminSnapshot(snapshot),
      isGuest: isGuestSnapshot(snapshot),
      loginMode: resolveAuthMode(snapshot),
      loginModalOpen: snapshot.loginModalOpen,
      loginNotice: snapshot.modalNotice,
      openLogin,
      closeLogin,
      signOut,
      refresh,
      completeSignIn,
    }),
    [closeLogin, completeSignIn, openLogin, refresh, signOut, snapshot],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <LoginModal />
    </AuthContext.Provider>
  );
}

export { useAuth, useOptionalAuth, type AuthContextValue } from '@/components/auth/auth-context';
