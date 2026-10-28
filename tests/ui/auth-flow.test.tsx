/**
 * Guest-first console + sign-in flows (WP auth-ui).
 *
 * What is asserted here, and why it is asserted *this* way:
 *
 *  - **Transport truth** - every sign-in, sign-up, sign-out, 403 and 401 below goes
 *    through the real `/api/auth/**` and `/api/admin/**` route handlers, wired into
 *    `fetch` by `support/admin-harness.ts`. No handler is mocked, so the client and
 *    the account API are tested against each other, not against a fixture.
 *  - **UI state** - the console may not add jsdom/testing-library, so the dialogs
 *    and hooks keep their decisions in pure reducers/pipelines
 *    (`authReducer`, `captchaReducer`, `submitAuthForm`, `describeAuthFailure`)
 *    which are driven here exactly as the components drive them.
 *  - **Markup** - `react-dom/server` renders the real shell (`AuthProvider` +
 *    `AuthGuard`) so "the guest sees sidebar, top bar and a sign-in mask, and the
 *    panel is not mounted" is a rendered assertion, not a promise.
 *  - **Wiring** - where only a live DOM could observe the truth (focus trap,
 *    Escape, the expiry subscription opening the dialog), the source is read and
 *    the wiring is asserted as static evidence, never as runtime behaviour.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console/keys',
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import {
  ADMIN_REQUIRED_MESSAGE,
  ApiError,
  SESSION_EXPIRED_MESSAGE,
  describeApiFailure,
  fetchAuthState,
  fetchCaptcha,
  isForbidden,
  listKeys,
  login,
  logout,
  register,
  updateSettings,
} from '@/components/console/api';
import { AdminRequiredMask } from '@/components/auth/AccessMasks';
import { KeysPanel } from '@/components/console/KeysPanel';
import { AuthGuard } from '@/components/console/AuthGuard';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { LoginForm } from '@/app/login/LoginForm';
import { ToastProvider } from '@/components/ui/Toast';
import {
  authReducer,
  initialAuthSnapshot,
  isAdminSnapshot,
  resolveAuthMode,
  type AuthSnapshot,
} from '@/components/auth/auth-machine';
import {
  describeAuthFailure,
  shouldRefreshCaptcha,
  submitAuthForm,
} from '@/components/auth/auth-submit';
import {
  ADMIN_REQUIRED_DESCRIPTION,
  ADMIN_REQUIRED_TITLE,
  CAPTCHA_FAILED_MESSAGE,
  CREDENTIAL_FAILED_MESSAGE,
  GUEST_MASK_TITLE,
  REGISTRATION_CLOSED_MESSAGE,
  SESSION_EXPIRED_NOTICE,
} from '@/components/auth/messages';
import { captchaReducer, initialCaptchaState } from '@/components/auth/use-captcha';
import {
  EMPTY_AUTH_VALUES,
  validateAuthForm,
  type AuthFormValues,
} from '@/components/auth/validation';
import {
  resetSessionExpiredListeners,
  subscribeSessionExpired,
} from '@/components/console/session-expiry';
import { createCaptcha, verifyCaptcha } from '@/lib/captcha';
import { setRegistrationEnabled } from '@/lib/settings';
import type { CaptchaChallengePublic, UserPublic } from '@/components/console/types';
import {
  TEST_ADMIN_PASSWORD,
  installAdminHarness,
  prepareGatewayEnv,
  type AdminHarness,
} from './support/admin-harness';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

const ADMIN_USER: UserPublic = {
  id: 'user-admin',
  username: 'admin',
  displayName: 'Operator',
  role: 'admin',
  status: 'active',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

const MEMBER_USER: UserPublic = {
  ...ADMIN_USER,
  id: 'user-member',
  username: 'member-one',
  displayName: null,
  role: 'member',
};

/** A challenge whose answer this test knows (the HTTP layer never chooses it). */
function solvedCaptcha(answer = 'ABCDE'): { challengeId: string; answer: string } {
  const challenge = createCaptcha(Date.now(), { answer });
  return { challengeId: challenge.id, answer };
}

function valuesWith(overrides: Partial<AuthFormValues>): AuthFormValues {
  return { ...EMPTY_AUTH_VALUES, ...overrides };
}

/** A captcha-shaped object for reducer-level assertions (never fetched). */
function challengeFixture(id: string): CaptchaChallengePublic {
  return { challengeId: id, imageDataUrl: `data:image/svg+xml;base64,${id}`, expiresAt: '' };
}

/** Render the console shell for a pinned auth state. */
function renderShell(state: Partial<AuthSnapshot>, childText = 'PANEL CONTENT MARKER'): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <AuthProvider initialState={state}>
        <AuthGuard>
          <p>{childText}</p>
        </AuthGuard>
      </AuthProvider>
    </ToastProvider>,
  );
}

describe('guest-first shell', () => {
  it('renders sidebar, top bar and the sign-in mask for a guest and mounts no panel', () => {
    const markup = renderShell({ status: 'guest', registrationEnabled: true });

    // Sidebar navigation and the account area are there.
    expect(markup).toContain('Console sections');
    expect(markup).toContain('API keys');
    expect(markup).toContain('Providers');
    // The mask replaces only the panel area.
    expect(markup).toContain(GUEST_MASK_TITLE);
    // The protected content is *not* mounted, so no panel can request data.
    expect(markup).not.toContain('PANEL CONTENT MARKER');
    // The deep-link fallback is offered, with the current path as ?next=.
    expect(markup).toContain('/login?next=%2Fconsole%2Fkeys');
  });

  it('shows only the skeleton while the session probe is in flight', () => {
    const markup = renderShell({ status: 'loading' });
    expect(markup).toContain('Checking your session');
    expect(markup).not.toContain(GUEST_MASK_TITLE);
    expect(markup).not.toContain('PANEL CONTENT MARKER');
  });

  it('mounts the panels for an administrator', () => {
    const markup = renderShell({ status: 'authenticated', user: ADMIN_USER });
    expect(markup).toContain('PANEL CONTENT MARKER');
    expect(markup).not.toContain(GUEST_MASK_TITLE);
    expect(markup).not.toContain(ADMIN_REQUIRED_TITLE);
    // Account area: display name plus the admin role badge and the sign-out action.
    expect(markup).toContain('Operator');
    expect(markup).toContain('Sign out');
  });

  it('keeps the shell but refuses the panels for a member', () => {
    const markup = renderShell({ status: 'authenticated', user: MEMBER_USER });
    expect(markup).toContain('Console sections');
    expect(markup).toContain(ADMIN_REQUIRED_TITLE);
    expect(markup).not.toContain('PANEL CONTENT MARKER');
    expect(markup).toContain('member-one');
  });

  it('never hard-gates the console on a session cookie any more', () => {
    const layout = read('app/console/layout.tsx');
    expect(layout).toContain('<AuthProvider>');
    expect(layout).toContain('<AuthGuard>');
    // The retired gate: a server-side redirect before any markup is produced.
    expect(layout).not.toContain('requireSession');
    expect(layout).not.toContain('redirect(');

    const guard = read('components/console/AuthGuard.tsx');
    expect(guard).not.toContain("router.replace(");
    expect(guard).not.toContain('buildLoginRedirect');
    // Guests are answered with the dialog, including when they click the sidebar.
    expect(guard).toContain('guardNavigation');
    expect(guard).toContain("openLogin('login')");
  });
});

describe('auth state machine', () => {
  it('opens the dialog, then closes it once the server confirms the account', () => {
    let state: AuthSnapshot = {
      ...initialAuthSnapshot,
      status: 'guest',
      registrationEnabled: true,
    };
    state = authReducer(state, { type: 'open-login', mode: 'login' });
    expect(state.loginModalOpen).toBe(true);
    expect(state.modalNotice).toBeNull();

    state = authReducer(state, {
      type: 'session-loaded',
      user: ADMIN_USER,
      registrationEnabled: true,
    });
    expect(state.status).toBe('authenticated');
    expect(state.loginModalOpen).toBe(false);
    expect(isAdminSnapshot(state)).toBe(true);
  });

  it('returns to the guest view and reopens the dialog when the session expires', () => {
    let state: AuthSnapshot = {
      ...initialAuthSnapshot,
      status: 'authenticated',
      user: ADMIN_USER,
      registrationEnabled: true,
    };
    state = authReducer(state, {
      type: 'open-login',
      mode: 'login',
      notice: SESSION_EXPIRED_NOTICE,
    });
    state = authReducer(state, {
      type: 'session-loaded',
      user: null,
      registrationEnabled: true,
    });
    expect(state.status).toBe('guest');
    expect(state.user).toBeNull();
    // The dialog stays open with its notice: the operator was interrupted mid-task
    // and must not have to hunt for the sign-in entry point.
    expect(state.loginModalOpen).toBe(true);
    expect(state.modalNotice).toBe(SESSION_EXPIRED_NOTICE);
    expect(isAdminSnapshot(state)).toBe(false);
  });

  it('drops a stale identity when the probe itself fails', () => {
    const state = authReducer(
      { ...initialAuthSnapshot, status: 'authenticated', user: ADMIN_USER },
      { type: 'session-unavailable', message: 'HTTP 500' },
    );
    expect(state.status).toBe('guest');
    expect(state.user).toBeNull();
    expect(isAdminSnapshot(state)).toBe(false);
  });

  it('closes the dialog on an explicit sign-out', () => {
    const state = authReducer(
      { ...initialAuthSnapshot, status: 'authenticated', user: MEMBER_USER, loginModalOpen: true },
      { type: 'signed-out' },
    );
    expect(state.status).toBe('guest');
    expect(state.loginModalOpen).toBe(false);
  });

  it('downgrades the register tab when an administrator closes sign-ups', () => {
    const opened = authReducer(
      { ...initialAuthSnapshot, status: 'guest', registrationEnabled: true },
      { type: 'open-login', mode: 'register' },
    );
    expect(resolveAuthMode(opened)).toBe('register');
    const closed = authReducer(opened, { type: 'registration-changed', enabled: false });
    expect(resolveAuthMode(closed)).toBe('login');
    expect(closed.registrationEnabled).toBe(false);
  });
});

describe('sign-in, sign-up and sign-out against the real handlers', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    resetSessionExpiredListeners();
  });

  afterEach(() => {
    resetSessionExpiredListeners();
    vi.unstubAllGlobals();
  });

  it('signs the bootstrap administrator in and stores a session cookie', async () => {
    const captcha = solvedCaptcha();
    const user = await login({
      username: 'admin',
      password: TEST_ADMIN_PASSWORD,
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });

    expect(user.role).toBe('admin');
    expect(harness.cookie()).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/i);

    const state = await fetchAuthState();
    expect(state.user?.username).toBe('admin');
    expect(state.registration.enabled).toBe(true);
  });

  it('runs the whole dialog submission: captcha, login, session refresh', async () => {
    const captcha = solvedCaptcha();
    const outcome = await submitAuthForm({
      mode: 'login',
      values: valuesWith({
        username: 'admin',
        password: TEST_ADMIN_PASSWORD,
        captchaAnswer: captcha.answer,
      }),
      challengeId: captcha.challengeId,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.user.username).toBe('admin');

    const state = await fetchAuthState();
    expect(state.user?.role).toBe('admin');
  });

  it('creates a member account and signs it in immediately', async () => {
    const captcha = solvedCaptcha();
    const outcome = await submitAuthForm({
      mode: 'register',
      values: valuesWith({
        username: 'member-one',
        password: 'Quiet-H4rbour-1',
        displayName: 'Member One',
        captchaAnswer: captcha.answer,
      }),
      challengeId: captcha.challengeId,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Registration never mints an administrator.
    expect(outcome.user.role).toBe('member');
    expect(outcome.user.displayName).toBe('Member One');
    expect(harness.cookie()).not.toBeNull();

    const state = await fetchAuthState();
    expect(state.user?.username).toBe('member-one');
  });

  it('explains a closed registration switch instead of showing a raw 403', async () => {
    setRegistrationEnabled(false);
    const captcha = solvedCaptcha();
    const outcome = await submitAuthForm({
      mode: 'register',
      values: valuesWith({
        username: 'member-two',
        password: 'Quiet-H4rbour-1',
        captchaAnswer: captcha.answer,
      }),
      challengeId: captcha.challengeId,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.form).toBe(REGISTRATION_CLOSED_MESSAGE);
    // The refusal happened before the captcha check, so the switch is the reason.
    expect(outcome.status).toBe(403);
  });

  it('revokes the session on sign-out and reports a guest afterwards', async () => {
    const captcha = solvedCaptcha();
    await login({
      username: 'admin',
      password: TEST_ADMIN_PASSWORD,
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });
    const token = harness.cookie();
    expect(token).not.toBeNull();

    await logout();
    expect(harness.cookie()).toBeNull();

    const state = await fetchAuthState();
    expect(state.user).toBeNull();
    expect(state.registration.enabled).toBe(true);
  });
});

describe('captcha handling', () => {
  beforeEach(() => {
    prepareGatewayEnv();
    installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves a fresh challenge per request', async () => {
    const first = await fetchCaptcha();
    const second = await fetchCaptcha();

    expect(first.challengeId).not.toBe(second.challengeId);
    expect(first.imageDataUrl.startsWith('data:image/svg+xml')).toBe(true);
    expect(first.imageDataUrl.length).toBeGreaterThan(200);
  });

  it('replaces the image when a refresh is requested, and reports the loading state', () => {
    const first = challengeFixture('a');
    const second = challengeFixture('b');

    let state = captchaReducer(initialCaptchaState, { type: 'requested' });
    expect(state.loading).toBe(true);

    state = captchaReducer(state, { type: 'received', challenge: first });
    expect(state.loading).toBe(false);
    expect(state.challenge?.challengeId).toBe('a');

    state = captchaReducer(state, { type: 'requested' });
    expect(state.loading).toBe(true);
    state = captchaReducer(state, { type: 'received', challenge: second });
    expect(state.challenge?.challengeId).toBe('b');
  });

  it('clears a challenge that could not be loaded instead of showing a dead image', () => {
    const state = captchaReducer(
      captchaReducer(initialCaptchaState, {
        type: 'received',
        challenge: challengeFixture('a'),
      }),
      { type: 'failed', message: 'offline' },
    );
    expect(state.challenge).toBeNull();
    expect(state.error).toBe('offline');
    expect(state.loading).toBe(false);
  });

  it('burns the challenge on a correct answer, so a failed attempt always needs a new one', () => {
    const captcha = solvedCaptcha();
    expect(verifyCaptcha(captcha.challengeId, captcha.answer)).toBe(true);
    // Consumed: the very same code cannot be submitted twice.
    expect(verifyCaptcha(captcha.challengeId, captcha.answer)).toBe(false);
    expect(shouldRefreshCaptcha({ ok: false, errors: {} as never, status: 401 })).toBe(true);
  });

  it('makes the image itself the refresh control and announces the loading state', () => {
    const field = read('components/auth/CaptchaField.tsx');
    expect(field).toContain('<img');
    expect(field).toContain('onClick={onRefresh}');
    expect(field).toContain('aria-busy={loading || undefined}');
    expect(field).toContain('Load a new security code');
    // The answer is never echoed or prefilled.
    expect(field).not.toMatch(/value="\{?challenge/);
  });
});

describe('inline failures', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    resetSessionExpiredListeners();
  });

  afterEach(() => {
    resetSessionExpiredListeners();
    vi.unstubAllGlobals();
  });

  it('keeps a wrong password inline and never raises the expiry signal', async () => {
    const expired = vi.fn();
    subscribeSessionExpired(expired);
    const captcha = solvedCaptcha();

    const outcome = await submitAuthForm({
      mode: 'login',
      values: valuesWith({
        username: 'admin',
        password: 'not-the-password',
        captchaAnswer: captcha.answer,
      }),
      challengeId: captcha.challengeId,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.form).toBe(CREDENTIAL_FAILED_MESSAGE);
    expect(harness.cookie()).toBeNull();
    // `/api/auth/**` 401 means "wrong credentials", not "session expired".
    expect(expired).not.toHaveBeenCalled();
  });

  it('puts a wrong captcha on the captcha field and asks for a new code', async () => {
    const captcha = solvedCaptcha('ABCDE');
    const outcome = await submitAuthForm({
      mode: 'login',
      values: valuesWith({
        username: 'admin',
        password: TEST_ADMIN_PASSWORD,
        captchaAnswer: 'ZZZZZ',
      }),
      challengeId: captcha.challengeId,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.captcha).toBe(CAPTCHA_FAILED_MESSAGE);
    expect(outcome.errors.form).toBe(CAPTCHA_FAILED_MESSAGE);
    expect(shouldRefreshCaptcha(outcome)).toBe(true);
    // Nothing was created: a failed captcha is refused before any credential work.
    expect(harness.cookie()).toBeNull();
  });

  it('blocks an empty form locally, before spending a challenge', async () => {
    const deps = { login: vi.fn(), register: vi.fn() };
    const outcome = await submitAuthForm(
      { mode: 'login', values: EMPTY_AUTH_VALUES, challengeId: 'challenge-1' },
      deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.username).not.toBeNull();
    expect(outcome.errors.password).not.toBeNull();
    expect(outcome.errors.captcha).not.toBeNull();
    expect(deps.login).not.toHaveBeenCalled();
  });

  it('mirrors the gateway password policy for registration', () => {
    const errors = validateAuthForm(
      'register',
      valuesWith({ username: 'alice', password: 'alice2024', captchaAnswer: 'ABCDE' }),
    );
    // Contains the username: the server would answer 400, the form says so first.
    expect(errors.password).toBe('The password must not contain the username.');

    const weak = validateAuthForm(
      'register',
      valuesWith({ username: 'alice', password: 'nodigits', captchaAnswer: 'ABCDE' }),
    );
    expect(weak.password).toBe('The password must contain at least one digit.');

    // Signing in only requires a value: the server decides whether it is right.
    const signInValues = valuesWith({ username: 'alice', password: 'x', captchaAnswer: 'A' });
    expect(validateAuthForm('login', signInValues).password).toBeNull();
  });

  it('maps a transport failure to actionable copy', () => {
    expect(describeAuthFailure(new ApiError('', 0, 'network'), 'login')).toEqual(
      expect.objectContaining({ form: expect.stringContaining('could not be reached') }),
    );
    expect(describeAuthFailure(new ApiError('too many', 429), 'login').form).toContain(
      'Too many failed attempts',
    );
  });
});

describe('member role: 403 is not an expired session', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    resetSessionExpiredListeners();
  });

  afterEach(() => {
    resetSessionExpiredListeners();
    vi.unstubAllGlobals();
  });

  it('answers 403, shows administrator-only copy and stays put', async () => {
    const captcha = solvedCaptcha();
    const member = await register({
      username: 'member-one',
      password: 'Quiet-H4rbour-1',
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });
    expect(member.role).toBe('member');

    const expired = vi.fn();
    subscribeSessionExpired(expired);
    const failure = await listKeys().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(isForbidden(failure)).toBe(true);
    expect((failure as ApiError).status).toBe(403);
    // The transport keeps the server's word; the console translates it.
    expect(describeApiFailure(failure)).toBe(ADMIN_REQUIRED_MESSAGE);
    expect(expired).not.toHaveBeenCalled();
    // The member is still signed in: nothing revoked the session.
    expect((await fetchAuthState()).user?.username).toBe('member-one');
  });

  it('offers a way out from the administrator-only mask', () => {
    const markup = renderToStaticMarkup(
      <AdminRequiredMask user={MEMBER_USER} onSignOut={() => undefined} />,
    );
    expect(markup).toContain(ADMIN_REQUIRED_TITLE);
    expect(markup).toContain(ADMIN_REQUIRED_DESCRIPTION);
    expect(markup).toContain('Sign out');
  });

  it('lets an administrator toggle the registration switch the dialog reads', async () => {
    const captcha = solvedCaptcha();
    await login({
      username: 'admin',
      password: TEST_ADMIN_PASSWORD,
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });

    await expect(updateSettings({ enabled: false })).resolves.toEqual({ enabled: false });
    const guestView = await fetchAuthState();
    expect(guestView.registration.enabled).toBe(false);

    await expect(updateSettings({ enabled: true })).resolves.toEqual({ enabled: true });
    expect(harness.cookie()).not.toBeNull();
  });
});

describe('expired session handling', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    resetSessionExpiredListeners();
  });

  afterEach(() => {
    resetSessionExpiredListeners();
    vi.unstubAllGlobals();
  });

  it('announces exactly one expiry for a 401 from the admin surface', async () => {
    const expired = vi.fn();
    subscribeSessionExpired(expired);

    const failure = await listKeys().catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(401);
    expect((failure as ApiError).message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(harness.cookie()).toBeNull();
  });

  it('answers with the dialog instead of navigating to /login', () => {
    const guard = read('components/console/AuthGuard.tsx');
    // Subscribed once, at the shell.
    expect(guard).toContain('subscribeSessionExpired(');
    // Opens the dialog with the expiry notice and re-reads the truth.
    expect(guard).toContain("openLogin('login', SESSION_EXPIRED_NOTICE)");
    expect(guard).toContain('refresh()');
    // No redirect anywhere: the retired behaviour must not creep back in.
    expect(guard).not.toContain("router.replace");
    expect(guard).not.toContain("'/login'");

    // Every panel keeps using the per-error hook; it now opens the dialog too.
    for (const panel of ['KeysPanel.tsx', 'ProvidersPanel.tsx', 'LogsPanel.tsx']) {
      expect(read(`components/console/${panel}`)).toContain('useSessionExpiryRedirect');
    }
    expect(guard).toContain('export function useSessionExpiryRedirect');

    // The transport still raises the signal only for the admin surface.
    const api = read('components/console/api.ts');
    expect(api).toContain("if (scope === 'auth') return new ApiError(");
    expect(api).toContain("readErrorMessage(body, 401), 401, 'http'");
  });
});

describe('sign-in dialog', () => {
  it('is a real modal: aria-modal, Escape, backdrop dismissal and a focus trap', () => {
    const modal = read('components/ui/Modal.tsx');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain('onClick={requestClose}');
    expect(modal).toContain('const FOCUSABLE');
    expect(modal).toContain('previouslyFocused.current?.focus?.()');

    const dialog = read('components/auth/LoginModal.tsx');
    expect(dialog).toContain('<Modal');
    expect(dialog).toContain('onClose={auth.closeLogin}');
    expect(dialog).toContain('busy={busy}');
    // The premium framing uses the existing tokens only.
    expect(dialog).toContain('var(--brand-soft)');
    expect(dialog).toContain('shadow-pop');
  });

  it('hosts the same form component as the /login fallback', () => {
    const dialog = read('components/auth/LoginModal.tsx');
    const page = read('app/login/LoginForm.tsx');
    expect(dialog).toContain('<AuthForm');
    expect(page).toContain('<AuthForm');
  });

  it('offers sign-in and register tabs, with the reason when sign-ups are closed', () => {
    const form = read('components/auth/AuthForm.tsx');
    expect(form).toContain("value: 'login'");
    expect(form).toContain("value: 'register'");
    expect(form).toContain('disabled: !registrationEnabled');
    expect(form).toContain('REGISTRATION_CLOSED_REASON');
  });
});

describe('/login deep link', () => {
  it('renders the shared form with username, password and captcha controls', () => {
    const markup = renderToStaticMarkup(<LoginForm nextPath="/console/providers" />);

    expect(markup).toContain('name="username"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('name="captchaAnswer"');
    expect(markup).toContain('Security code');
    expect(markup).toContain('Load a new security code');
    expect(markup).toContain('role="tablist"');
    // First paint never announces a failure.
    expect(markup).not.toContain('role="alert"');
  });

  it('sanitises ?next= on the server and redirects to it after a successful sign-in', () => {
    const page = read('app/login/page.tsx');
    expect(page).toContain('sanitizeNextPath');
    expect(page).toMatch(/<LoginForm nextPath=\{nextPath\}/);

    const form = read('app/login/LoginForm.tsx');
    expect(form).toContain('router.replace(nextPath)');
    expect(form).toContain('router.refresh()');
    expect(form).not.toMatch(/window\.alert/);
  });
});

/**
 * Cross-module boundary checks added by the test pass (WP auth-ui).
 *
 * These close the two seams the feature suites above leave implicit:
 *   - the browser-side form policy (`components/auth/validation.ts`) against the
 *     *gateway* password/username policy, so a value the client accepts never dies
 *     as an unexplained 400;
 *   - the shell (`AuthProvider` + `AuthGuard`) against a *real* panel, so "a guest
 *     mounts no panel" is proven with `KeysPanel` itself rather than a marker <p>.
 */
describe('boundary: form policy vs the real gateway policy', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    resetSessionExpiredListeners();
  });

  afterEach(() => {
    resetSessionExpiredListeners();
    vi.unstubAllGlobals();
  });

  it('routes an over-long password to the password field and creates nothing', async () => {
    // Longer than the gateway's 200-character budget.
    const overLong = `Aa1${'x'.repeat(210)}`;
    // Pinned divergence: the client form has no upper bound, so the value is sent.
    expect(validateAuthForm('register', valuesWith({ username: 'longpass-user', password: overLong, captchaAnswer: 'ABCDE' })).password).toBeNull();

    const captcha = solvedCaptcha();
    const outcome = await submitAuthForm({
      mode: 'register',
      values: valuesWith({
        username: 'longpass-user',
        password: overLong,
        captchaAnswer: captcha.answer,
      }),
      challengeId: captcha.challengeId,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    // The refusal lands on the control it belongs to, not on a form-level banner.
    expect(outcome.errors.password).not.toBeNull();
    expect(outcome.errors.form).toBeNull();
    expect(harness.cookie()).toBeNull();
    expect((await fetchAuthState()).user).toBeNull();
  });

  it('reports a taken username on the username field, not as a generic failure', async () => {
    const first = solvedCaptcha();
    await register({
      username: 'taken-one',
      password: 'Quiet-H4rbour-1',
      challengeId: first.challengeId,
      captchaAnswer: first.answer,
    });

    const second = solvedCaptcha();
    const outcome = await submitAuthForm({
      mode: 'register',
      values: valuesWith({
        username: 'taken-one',
        password: 'Quiet-H4rbour-2',
        captchaAnswer: second.answer,
      }),
      challengeId: second.challengeId,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.username).toContain('already taken');
    expect(outcome.errors.captcha).toBeNull();
  });

  it('keeps the session intact when a duplicate sign-up is refused', async () => {
    const captcha = solvedCaptcha();
    await register({
      username: 'dup-user',
      password: 'Quiet-H4rbour-1',
      challengeId: captcha.challengeId,
      captchaAnswer: captcha.answer,
    });
    const token = harness.cookie();
    expect(token).not.toBeNull();

    const retry = solvedCaptcha();
    await submitAuthForm({
      mode: 'register',
      values: valuesWith({
        username: 'dup-user',
        password: 'Quiet-H4rbour-3',
        captchaAnswer: retry.answer,
      }),
      challengeId: retry.challengeId,
    });

    // A refused write must not disturb the session that is already signed in.
    expect(harness.cookie()).toBe(token);
    expect((await fetchAuthState()).user?.username).toBe('dup-user');
  });
});

describe('boundary: the shell vs a real panel', () => {
  it('never mounts KeysPanel for a guest, and mounts it for an administrator', () => {
    const guest = renderToStaticMarkup(
      <ToastProvider>
        <AuthProvider initialState={{ status: 'guest', registrationEnabled: true }}>
          <AuthGuard>
            <KeysPanel />
          </AuthGuard>
        </AuthProvider>
      </ToastProvider>,
    );
    // The panel's own controls are absent, so it cannot have issued a request.
    expect(guest).not.toContain('Create key');
    expect(guest).not.toContain('Loading keys');
    expect(guest).toContain(GUEST_MASK_TITLE);

    const admin = renderToStaticMarkup(
      <ToastProvider>
        <AuthProvider initialState={{ status: 'authenticated', user: ADMIN_USER }}>
          <AuthGuard>
            <KeysPanel />
          </AuthGuard>
        </AuthProvider>
      </ToastProvider>,
    );
    expect(admin).toContain('API keys');
    expect(admin).not.toContain(GUEST_MASK_TITLE);
  });
});
