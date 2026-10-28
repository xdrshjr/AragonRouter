'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';
import { submitAuthForm, shouldRefreshCaptcha } from '@/components/auth/auth-submit';
import { CaptchaField } from '@/components/auth/CaptchaField';
import { PasswordField } from '@/components/auth/PasswordField';
import { useCaptcha } from '@/components/auth/use-captcha';
import {
  DISPLAY_NAME_LABEL,
  PASSWORD_HINT,
  PASSWORD_LABEL,
  REGISTER_TAB,
  REGISTER_TITLE,
  REGISTRATION_CLOSED_REASON,
  SIGN_IN_TAB,
  SIGN_IN_TITLE,
  USERNAME_HINT,
  USERNAME_LABEL,
} from '@/components/auth/messages';
import {
  EMPTY_AUTH_VALUES,
  emptyAuthErrors,
  firstInvalidField,
  type AuthFormErrors,
  type AuthFormValues,
} from '@/components/auth/validation';
import type { AuthMode, UserPublic } from '@/components/console/types';

export interface AuthFormProps {
  /** Active tab; owned by the caller so the dialog and `/login` can share it. */
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  /** C-AUTH-WIRE `registration.enabled` - the register tab is disabled when false. */
  registrationEnabled: boolean;
  /** Called with the account once the server has accepted the credentials. */
  onAuthenticated: (user: UserPublic) => void;
  /** Optional announcement above the fields (e.g. an expired session). */
  notice?: string | null;
  /** Move focus to the username field on mount (the dialog does, the page does not). */
  autoFocus?: boolean;
  /** Lets the host freeze dismissal while a submit is in flight. */
  onPendingChange?: (pending: boolean) => void;
  className?: string;
}

/** Card-level notes (registration closed, trust lines) share one tone. */
const NOTE_CLASS =
  'rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[11px] leading-4 text-muted';
/** Session-expired style announcement. */
const INFO_CLASS =
  'rounded-md border border-brand/40 bg-[color:var(--brand-soft)] px-2.5 py-2 ' +
  'text-xs leading-5 text-text';
/** Form-level failure banner. */
const ALERT_CLASS =
  'rounded-md border border-danger/40 bg-[color:var(--danger-soft)] px-2.5 py-2 ' +
  'text-xs leading-5 text-danger';

/** The account form shared by the sign-in dialog and the `/login` fallback. */
export function AuthForm({
  mode,
  onModeChange,
  registrationEnabled,
  onAuthenticated,
  notice = null,
  autoFocus = false,
  onPendingChange,
  className,
}: AuthFormProps): ReactNode {
  const [values, setValues] = useState<AuthFormValues>(EMPTY_AUTH_VALUES);
  const [errors, setErrors] = useState<AuthFormErrors>(emptyAuthErrors);
  const [pending, setPending] = useState(false);
  const captcha = useCaptcha(true);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const displayNameRef = useRef<HTMLInputElement | null>(null);
  const captchaRef = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    onPendingChange?.(pending);
  }, [onPendingChange, pending]);

  useEffect(() => {
    if (autoFocus) usernameRef.current?.focus();
  }, [autoFocus, mode]);

  // Switching tabs must not carry a stale password, answer or message across.
  useEffect(() => {
    setValues((current) => ({ ...current, password: '', displayName: '', captchaAnswer: '' }));
    setErrors(emptyAuthErrors());
  }, [mode]);

  const setField = useCallback((field: keyof AuthFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    // Typing clears the message attached to that control (and the form banner).
    setErrors((current) => ({ ...current, [field]: null, form: null }));
  }, []);

  const focusFirstInvalid = useCallback((next: AuthFormErrors) => {
    const field = firstInvalidField(next);
    if (field === 'username') usernameRef.current?.focus();
    else if (field === 'password') passwordRef.current?.focus();
    else if (field === 'displayName') displayNameRef.current?.focus();
    else if (field === 'captchaAnswer') captchaRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;
      setPending(true);
      const outcome = await submitAuthForm({
        mode,
        values,
        challengeId: captcha.challenge?.challengeId ?? null,
      });
      if (!mounted.current) return;
      setPending(false);
      if (outcome.ok) {
        setValues((current) => ({ ...current, password: '', captchaAnswer: '' }));
        setErrors(emptyAuthErrors());
        onAuthenticated(outcome.user);
        return;
      }
      setErrors(outcome.errors);
      setValues((current) => ({ ...current, captchaAnswer: '' }));
      // A verified captcha is single-use, so every failed attempt needs a new code.
      if (shouldRefreshCaptcha(outcome)) captcha.refresh();
      focusFirstInvalid(outcome.errors);
    },
    [captcha, focusFirstInvalid, mode, onAuthenticated, pending, values],
  );

  const submittingLabel = mode === 'login' ? 'Signing in' : 'Creating account';
  const submitIcon =
    mode === 'login' ? (
      <LogIn size={14} aria-hidden="true" />
    ) : (
      <UserPlus size={14} aria-hidden="true" />
    );

  return (
    <div className={cn('space-y-4', className)}>
      <Tabs<AuthMode>
        items={[
          { value: 'login', label: SIGN_IN_TAB },
          { value: 'register', label: REGISTER_TAB, disabled: !registrationEnabled },
        ]}
        value={mode}
        onChange={onModeChange}
        label="Sign in or create an account"
        variant="segmented"
        size="md"
        className="w-full"
      />

      {registrationEnabled ? null : (
        <p className={NOTE_CLASS}>{REGISTRATION_CLOSED_REASON}</p>
      )}

      {notice ? (
        <p role="status" className={INFO_CLASS}>
          {notice}
        </p>
      ) : null}

      <form
        onSubmit={handleSubmit}
        noValidate
        aria-busy={pending || undefined}
        className="space-y-3"
      >
        {errors.form ? (
          <p role="alert" className={ALERT_CLASS}>
            {errors.form}
          </p>
        ) : null}

        <Field label={USERNAME_LABEL} error={errors.username} hint={USERNAME_HINT} required>
          {({ id, describedBy }) => (
            <Input
              id={id}
              ref={usernameRef}
              name="username"
              value={values.username}
              onChange={(event) => {
                setField('username', event.target.value);
              }}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="your-name"
              invalid={errors.username !== null}
              aria-describedby={describedBy}
              disabled={pending}
            />
          )}
        </Field>

        <Field
          label={PASSWORD_LABEL}
          error={errors.password}
          hint={mode === 'register' ? PASSWORD_HINT : undefined}
          required
        >
          {({ id, describedBy }) => (
            <PasswordField
              id={id}
              describedBy={describedBy}
              inputRef={passwordRef}
              value={values.password}
              onChange={(value) => {
                setField('password', value);
              }}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              invalid={errors.password !== null}
              disabled={pending}
              placeholder={mode === 'login' ? 'Your password' : 'Choose a password'}
            />
          )}
        </Field>

        {mode === 'register' ? (
          <Field
            label={DISPLAY_NAME_LABEL}
            error={errors.displayName}
            hint="Optional, shown in the top bar."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                ref={displayNameRef}
                name="displayName"
                value={values.displayName}
                onChange={(event) => {
                  setField('displayName', event.target.value);
                }}
                autoComplete="nickname"
                spellCheck={false}
                placeholder="Your name"
                invalid={errors.displayName !== null}
                aria-describedby={describedBy}
                disabled={pending}
              />
            )}
          </Field>
        ) : null}

        <CaptchaField
          challenge={captcha.challenge}
          loading={captcha.loading}
          loadError={captcha.error}
          onRefresh={captcha.refresh}
          value={values.captchaAnswer}
          onChange={(value) => {
            setField('captchaAnswer', value);
          }}
          error={errors.captcha}
          disabled={pending}
          inputRef={captchaRef}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={pending}
          loadingLabel={submittingLabel}
          leftIcon={submitIcon}
        >
          {mode === 'login' ? SIGN_IN_TITLE : REGISTER_TITLE}
        </Button>
      </form>
    </div>
  );
}
