/**
 * Session-expiry signal (C3).
 *
 * The console cannot know that the `aragon_session` cookie expired until the API
 * answers 401 - and the API answers 401 to *queries and mutations alike*
 * (`GET /api/admin/keys`, `POST /api/admin/keys`, `PATCH /api/admin/providers/:id`,
 * `DELETE ...`, `POST .../test`, ...). Routing that decision through each panel
 * proved fragile: a panel that only watched its query error (or that filtered the
 * mutation error out of the dialog message) turned an expired session into a
 * button that silently did nothing.
 *
 * So the signal is raised exactly where the status is observed - inside
 * `api.ts`'s single request choke point - and the console shell (`AuthGuard`)
 * subscribes once:
 *
 *   `adminRequest` sees 401 -> `notifySessionExpired()` -> subscribed handler ->
 *   back to the guest view + `openLogin('login', "your session expired")`
 *
 * **No navigation happens.** The console is guest first: the shell stays, the
 * panel area is replaced by the mask, and the sign-in dialog opens over the page
 * the operator was working on. Only the `/api/admin/**` surface raises this
 * signal; a 401 from `/api/auth/**` is a wrong credential and stays inline in the
 * form.
 *
 * The channel carries no payload: it only says "the session is gone", so nothing
 * sensitive (cookie, password, upstream key) can travel through it.
 */

/** A handler invoked once per expiry notification. */
export type SessionExpiryListener = () => void;

const listeners = new Set<SessionExpiryListener>();

/**
 * Register a listener. Returns the unsubscribe function, so it can be returned
 * straight from a `useEffect` (the signal is global, the subscriber is not).
 */
export function subscribeSessionExpired(listener: SessionExpiryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Raise the signal. Listeners are copied first (a listener may unsubscribe while
 * being notified) and a throwing listener never stops the others: a broken
 * component must not prevent the redirect.
 */
export function notifySessionExpired(): void {
  if (listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Deliberately swallowed: the redirect of the other listeners matters more.
    }
  }
}

/** Number of live subscribers (diagnostics and tests only). */
export function sessionExpiryListenerCount(): number {
  return listeners.size;
}

/** Drop every subscriber (tests only; never called by the application). */
export function resetSessionExpiredListeners(): void {
  listeners.clear();
}

export interface SessionExpiryWatcher {
  /** Fires at most once, on the first notification, then stays silent. */
  handle: () => void;
  unsubscribe: () => void;
}

/**
 * One-shot view of the signal: several 401s from parallel requests (or the same
 * 401 observed by both the query and the redirect hook) must navigate once, not
 * fight over the history entry.
 *
 * The dedupe lives in the watcher, not in the publisher, because each subscriber
 * has its own idea of "already handled" (a shell redirects; a test counts).
 */
export function watchSessionExpiry(redirect: () => void): SessionExpiryWatcher {
  let fired = false;
  const handle = (): void => {
    if (fired) return;
    fired = true;
    redirect();
  };
  const unsubscribe = subscribeSessionExpired(handle);
  return { handle, unsubscribe };
}
