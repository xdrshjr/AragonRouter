/**
 * Authentication state machine (C-AUTH-CONTEXT).
 *
 * `AuthProvider` keeps its state in this pure reducer instead of scattering
 * `useState` calls, for two reasons:
 *   - the transitions are the interesting part of the contract (a signed-in user
 *     closes the dialog, an expired session reopens it, a guest keeps it shut until
 *     they ask), and they can be asserted exhaustively without a DOM;
 *   - the shell must never render an impossible combination, e.g. "authenticated
 *     with no user" or "guest with a user".
 *
 * Nothing here touches the network or React; `AuthProvider` is the only caller.
 */

import type { AuthMode, UserPublic } from '@/components/console/types';

/** C-AUTH-CONTEXT: the three states the console shell can be in. */
export type AuthStatus = 'loading' | 'guest' | 'authenticated';

export interface AuthSnapshot {
  status: AuthStatus;
  /** The signed-in account, or `null` for a guest / while loading. */
  user: UserPublic | null;
  /** C-AUTH-WIRE `registration.enabled`; the dialog needs it before sign-in. */
  registrationEnabled: boolean;
  loginModalOpen: boolean;
  loginMode: AuthMode;
  /** Optional announcement inside the dialog ("your session expired"). */
  modalNotice: string | null;
  /** True while a session probe is in flight after the first one. */
  refreshing: boolean;
}

export type AuthEvent =
  | { type: 'session-loading' }
  | { type: 'session-loaded'; user: UserPublic | null; registrationEnabled: boolean }
  | { type: 'session-unavailable'; message: string }
  | { type: 'open-login'; mode?: AuthMode; notice?: string | null }
  | { type: 'close-login' }
  | { type: 'authenticated'; user: UserPublic }
  | { type: 'signed-out' }
  | { type: 'registration-changed'; enabled: boolean };

/**
 * Before the first probe the shell knows nothing: it shows the skeleton rather
 * than the guest mask, so a signed-in operator never sees "sign in" flash by.
 */
export const initialAuthSnapshot: AuthSnapshot = {
  status: 'loading',
  user: null,
  registrationEnabled: false,
  loginModalOpen: false,
  loginMode: 'login',
  modalNotice: null,
  refreshing: false,
};

/** A guest answers nothing; an authenticated snapshot is only built from a user. */
function guestSnapshot(state: AuthSnapshot, patch: Partial<AuthSnapshot> = {}): AuthSnapshot {
  return { ...state, status: 'guest', user: null, refreshing: false, ...patch };
}

/**
 * Apply one event.
 *
 * Rules worth stating explicitly:
 *  - a fresh session probe always replaces the whole identity (it is the server's
 *    answer, not a hint), and a signed-in answer closes the dialog;
 *  - a failed probe degrades to guest instead of keeping a stale identity, because
 *    the alternative is a shell that renders admin chrome for a dead session;
 *  - an explicit sign-out leaves the dialog closed (the visitor asked to leave) and
 *    an expiry opens it (the visitor was interrupted mid-task).
 */
export function authReducer(state: AuthSnapshot, event: AuthEvent): AuthSnapshot {
  switch (event.type) {
    case 'session-loading':
      return { ...state, refreshing: true };
    case 'session-loaded':
      return event.user
        ? {
            ...state,
            status: 'authenticated',
            user: event.user,
            registrationEnabled: event.registrationEnabled,
            refreshing: false,
            loginModalOpen: false,
            modalNotice: null,
          }
        : guestSnapshot(state, {
            registrationEnabled: event.registrationEnabled,
            // The dialog and its notice survive the probe: an expiry opens it and
            // the guest answer must not make it vanish under the visitor's hands.
          });
    case 'session-unavailable':
      return guestSnapshot(state, {
        // No identity may survive a failed probe, but the dialog stays usable.
        modalNotice: state.loginModalOpen ? event.message : state.modalNotice,
      });
    case 'open-login':
      return {
        ...state,
        loginModalOpen: true,
        loginMode: event.mode ?? state.loginMode,
        modalNotice: event.notice ?? null,
      };
    case 'close-login':
      return { ...state, loginModalOpen: false, modalNotice: null };
    case 'authenticated':
      return {
        ...state,
        status: 'authenticated',
        user: event.user,
        refreshing: false,
        loginModalOpen: false,
        modalNotice: null,
      };
    case 'signed-out':
      return guestSnapshot(state, { loginModalOpen: false, modalNotice: null });
    case 'registration-changed':
      return {
        ...state,
        registrationEnabled: event.enabled,
        // A closed switch must not leave the dialog on a form that cannot submit.
        loginMode: event.enabled ? state.loginMode : 'login',
      };
    default:
      return state;
  }
}

/** True when the signed-in account may use the administrator API. */
export function isAdminSnapshot(state: AuthSnapshot): boolean {
  return state.status === 'authenticated' && state.user?.role === 'admin';
}

/** True once the server has confirmed there is no session. */
export function isGuestSnapshot(state: AuthSnapshot): boolean {
  return state.status === 'guest';
}

/**
 * The mode the dialog should actually show.
 *
 * Switching the switch off while the register tab is open would leave a dead form
 * on screen, so the requested mode is downgraded here instead of in the view.
 */
export function resolveAuthMode(state: AuthSnapshot): AuthMode {
  return state.loginMode === 'register' && !state.registrationEnabled ? 'login' : state.loginMode;
}
