import type { Metadata } from 'next';
import { BrandMark } from '@/components/brand/BrandMark';
import { LoginForm } from '@/app/login/LoginForm';
import { sanitizeNextPath } from '@/components/console/nav';

export const metadata: Metadata = {
  title: 'Sign in',
};

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  /** Next 15: `searchParams` is a promise. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/login` - the only page outside the console shell.
 *
 * The `next` query parameter is sanitised on the server before it reaches the
 * client so an attacker cannot turn this page into an open redirect.
 */
export default async function LoginPage({ searchParams }: LoginPageProps): Promise<React.ReactNode> {
  const params = await searchParams;
  const rawNext = params.next;
  const nextPath = sanitizeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);

  return (
    <div className="dot-grid relative flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      {/* Brand glow, purely decorative. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(60%_120%_at_50%_0%,var(--brand-soft),transparent_70%)]"
      />
      <div className="relative w-full max-w-sm">
        {/* Brand mark sits above the card: same inline SVG as the favicon. */}
        <div className="mb-6 flex items-center justify-center">
          <BrandMark size={32} withWordmark />
        </div>

        <LoginForm nextPath={nextPath} />

        <p className="mt-4 text-center text-[11px] leading-4 text-muted">
          Admin access only. The session cookie is HttpOnly and lasts seven days.
        </p>
      </div>
    </div>
  );
}
