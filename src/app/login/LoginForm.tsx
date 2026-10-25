'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Input';
import { ThemeToggle } from '@/components/console/ThemeToggle';
import { validatePassword } from '@/components/console/validation';
import { SESSION_EXPIRED_MESSAGE, isUnauthorized, signIn } from '@/components/console/api';

interface LoginFormProps {
  /** Already-sanitised redirect target (same-origin path). */
  nextPath: string;
}

/**
 * Password form for C3.
 *
 * Wrong passwords produce an inline message under the field (never an alert
 * dialog). The field is marked `aria-invalid` and `aria-describedby` points at
 * the message; `Field` renders that message as a `role="alert"` live region, so
 * it is announced when it appears and stays attached to the input afterwards.
 * On success the router is refreshed so the console layout re-renders against
 * the freshly set cookie.
 */
export function LoginForm({ nextPath }: LoginFormProps): ReactNode {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;

      const problem = validatePassword(password);
      if (problem) {
        setError(problem);
        inputRef.current?.focus();
        return;
      }

      setPending(true);
      setError(null);
      try {
        await signIn(password);
        setPassword('');
        // `replace` keeps the login page out of history; refreshing re-runs the
        // server components so the console sees the new cookie.
        router.replace(nextPath);
        router.refresh();
      } catch (cause) {
        setPassword('');
        if (isUnauthorized(cause)) {
          setError('That password is not correct. Try again.');
        } else if (cause instanceof Error && cause.message === SESSION_EXPIRED_MESSAGE) {
          setError('That password is not correct. Try again.');
        } else {
          setError(cause instanceof Error ? cause.message : 'Sign in failed. Try again.');
        }
        inputRef.current?.focus();
      } finally {
        setPending(false);
      }
    },
    [nextPath, password, pending, router],
  );

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold leading-6 text-text">Sign in</h1>
          <p className="mt-1 text-xs leading-5 text-muted">
            Enter the admin password to open the console.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <form onSubmit={submit} noValidate className="space-y-3">
        <Field label="Admin password" error={error} required>
          {({ id, describedBy }) => (
            <Input
              id={id}
              ref={inputRef}
              type={showPassword ? 'text' : 'password'}
              name="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Your ADMIN_PASSWORD"
              invalid={error !== null}
              aria-describedby={describedBy}
              disabled={pending}
              trailing={
                <button
                  type="button"
                  onClick={() => {
                    setShowPassword((current) => !current);
                  }}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                >
                  {showPassword ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              }
            />
          )}
        </Field>

        <Button
          type="submit"
          variant="primary"
          block
          loading={pending}
          loadingLabel="Signing in"
          leftIcon={<LogIn size={14} aria-hidden="true" />}
        >
          Sign in
        </Button>
      </form>

      <p className="mt-3 text-[11px] leading-4 text-muted">
        Repeated failures are rate limited for one minute by the server.
      </p>
    </Card>
  );
}
