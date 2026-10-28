import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { BrandMark } from '@/components/brand/BrandMark';
import { LoginForm } from '@/app/login/LoginForm';
import { sanitizeNextPath } from '@/components/console/nav';
import { hasSessionCookieShape, SESSION_COOKIE } from '@/components/console/session-gate';

export const metadata: Metadata = {
  title: 'Sign in',
};

export const dynamic = 'force-dynamic';

/** Dark/light neutral page frame for the standalone sign-in page. */
const SHELL_CLASS =
  'dot-grid relative flex min-h-screen items-center justify-center bg-bg px-4 py-10';
/** Decorative brand glow above the card (same radial the console dialog uses). */
const GLOW_CLASS =
  'pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(60%_120%_at_50%_0%,' +
  'var(--brand-soft),transparent_70%)]';

interface LoginPageProps {
  /** Next 15: `searchParams` is a promise. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Was the request carrying a session-shaped cookie?
 *
 * `middleware`-free and cheap: only the *shape* is checked (C-TOKEN), never the
 * validity, and the value is not logged, echoed or forwarded. It exists so a person
 * whose session died is told "your session expired" instead of being greeted with a
 * blank form, which is also why a failed `cookies()` read (static render) simply
 * means "no hint".
 */
async function hadSessionCookie(): Promise<boolean> {
  try {
    const store = await cookies();
    return hasSessionCookieShape(store.get(SESSION_COOKIE)?.value);
  } catch {
    return false;
  }
}

/**
 * `/login` - the deep-link fallback for the dialog.
 *
 * It renders the *same* form component the dialog uses (`LoginForm` ->
 * `AuthForm`), so the two entry points cannot drift. The `next` query parameter is
 * sanitised on the server before it reaches the client, so this page can never be
 * turned into an open redirect.
 */
export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.ReactNode> {
  const params = await searchParams;
  const rawNext = params.next;
  const nextPath = sanitizeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);
  const expiredHint = await hadSessionCookie();

  return (
    <div className={SHELL_CLASS}>
      {/* Brand glow, purely decorative. */}
      <div
        aria-hidden="true"
        className={GLOW_CLASS}
      />
      <div className="relative w-full max-w-sm">
        {/* Brand mark sits above the card: same inline SVG as the favicon. */}
        <div className="mb-6 flex items-center justify-center">
          <BrandMark size={32} withWordmark />
        </div>

        <LoginForm nextPath={nextPath} sessionExpiredHint={expiredHint} />

        <p className="mt-4 text-center text-[11px] leading-4 text-muted">
          The session cookie is HttpOnly and lasts seven days. Guests can browse the console
          without an account; panel data needs one.
        </p>
      </div>
    </div>
  );
}
