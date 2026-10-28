/**
 * One sign-in / sign-up submission, end to end but without React.
 *
 * The dialog and the `/login` fallback both call {@link submitAuthForm}, so the
 * two entry points cannot behave differently: same validation, same request, same
 * error mapping, same "the challenge is burned, fetch a new one" decision.
 *
 * The transport functions are injected (defaulting to the real client) so the
 * whole pipeline can be driven against the real route handlers in
 * `tests/ui/auth-flow.test.tsx` without mounting a component.
 */

import {
  ApiError,
  isAbortError,
  isForbidden,
  isUnauthorized,
  login,
  register,
} from '@/components/console/api';
import type { LoginInput, RegisterInput, UserPublic } from '@/components/console/types';
import {
  CAPTCHA_FAILED_MESSAGE,
  CAPTCHA_NOT_READY_MESSAGE,
  CREDENTIAL_FAILED_MESSAGE,
  GENERIC_FAILED_MESSAGE,
  NETWORK_FAILED_MESSAGE,
  REGISTRATION_CLOSED_MESSAGE,
  THROTTLED_MESSAGE,
} from '@/components/auth/messages';
import {
  emptyAuthErrors,
  hasAuthErrors,
  validateAuthForm,
  type AuthFormErrors,
  type AuthFormValues,
} from '@/components/auth/validation';
import type { AuthMode } from '@/components/console/types';

/** What the form hands over: the values, the mode and the live challenge id. */
export interface AuthSubmission {
  mode: AuthMode;
  values: AuthFormValues;
  /** `null` while the captcha is still loading; the submit is refused locally. */
  challengeId: string | null;
}

export type AuthSubmitOutcome =
  | { ok: true; user: UserPublic }
  | { ok: false; errors: AuthFormErrors; status: number };

/** The two transport calls, injectable for tests and for future retry policies. */
export interface AuthSubmitDeps {
  login: (input: LoginInput) => Promise<UserPublic>;
  register: (input: RegisterInput) => Promise<UserPublic>;
}

export const defaultAuthSubmitDeps: AuthSubmitDeps = { login, register };

/** Fill one field while keeping every other message as it was. */
function fieldError(field: keyof AuthFormErrors, message: string): AuthFormErrors {
  return { ...emptyAuthErrors(), [field]: message };
}

/** The whole result is one form-level message. */
function formError(message: string): AuthFormErrors {
  return { ...emptyAuthErrors(), form: message };
}

/**
 * Translate a failed request into inline messages.
 *
 * Order matters: a captcha failure also mentions nothing else, a taken username
 * belongs on the username field, and a password-policy rejection belongs on the
 * password field. Everything else is a form-level announcement.
 */
export function describeAuthFailure(error: unknown, mode: AuthMode): AuthFormErrors {
  if (isAbortError(error)) return formError(GENERIC_FAILED_MESSAGE);
  if (!(error instanceof ApiError)) {
    const message = error instanceof Error ? error.message : '';
    return formError(message.trim().length > 0 ? message : GENERIC_FAILED_MESSAGE);
  }
  if (error.status === 403) return formError(REGISTRATION_CLOSED_MESSAGE);
  if (error.status === 429) return formError(THROTTLED_MESSAGE);
  if (error.status === 0 || error.kind === 'network') return formError(NETWORK_FAILED_MESSAGE);
  if (isUnauthorized(error)) {
    return formError(mode === 'login' ? CREDENTIAL_FAILED_MESSAGE : GENERIC_FAILED_MESSAGE);
  }
  if (isForbidden(error)) return formError(REGISTRATION_CLOSED_MESSAGE);
  const message = error.message.toLowerCase();
  if (message.includes('captcha')) {
    return { ...emptyAuthErrors(), captcha: CAPTCHA_FAILED_MESSAGE, form: CAPTCHA_FAILED_MESSAGE };
  }
  if (message.includes('username is already taken')) {
    return fieldError('username', 'That username is already taken. Choose another one.');
  }
  if (message.includes('password')) return fieldError('password', error.message);
  if (message.includes('displayname')) return fieldError('displayName', error.message);
  return formError(error.message);
}

/** Build the wire body without ever sending an unvalidated value. */
function buildInput(
  mode: AuthMode,
  values: AuthFormValues,
  challengeId: string,
): LoginInput | RegisterInput {
  const base: LoginInput = {
    username: values.username.trim(),
    password: values.password,
    challengeId,
    captchaAnswer: values.captchaAnswer.trim(),
  };
  if (mode === 'login') return base;
  return { ...base, displayName: values.displayName.trim() };
}

/**
 * Run one submission.
 *
 * Local validation runs first, so an obviously bad form never spends a captcha;
 * a missing challenge is refused with an actionable message instead of a request
 * that the server would answer 400 to.
 */
export async function submitAuthForm(
  submission: AuthSubmission,
  deps: AuthSubmitDeps = defaultAuthSubmitDeps,
): Promise<AuthSubmitOutcome> {
  const { mode, values, challengeId } = submission;
  const validation = validateAuthForm(mode, values);
  if (hasAuthErrors(validation)) return { ok: false, errors: validation, status: 0 };
  if (!challengeId) {
    return { ok: false, errors: formError(CAPTCHA_NOT_READY_MESSAGE), status: 0 };
  }

  const input = buildInput(mode, values, challengeId);
  try {
    const user = mode === 'login'
      ? await deps.login(input as LoginInput)
      : await deps.register(input as RegisterInput);
    return { ok: true, user };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return { ok: false, errors: describeAuthFailure(error, mode), status };
  }
}

/**
 * A failed attempt always needs a new challenge: a correct captcha is consumed by
 * the successful verification, so the code the visitor typed can never be reused.
 */
export function shouldRefreshCaptcha(outcome: AuthSubmitOutcome): boolean {
  return !outcome.ok;
}
