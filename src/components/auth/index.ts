/**
 * Barrel for the account layer.
 *
 * The contract names `@/components/auth/AuthProvider` (C-AUTH-CONTEXT), so that
 * module stays the canonical import; this barrel exists so a consumer that needs
 * the provider *and* the masks *and* the copy does not juggle six paths.
 */

export { AuthProvider, type AuthProviderProps } from '@/components/auth/AuthProvider';
export {
  useAuth,
  useOptionalAuth,
  AuthContext,
  type AuthContextValue,
} from '@/components/auth/auth-context';
export { LoginModal } from '@/components/auth/LoginModal';
export { AuthForm, type AuthFormProps } from '@/components/auth/AuthForm';
export {
  AdminRequiredMask,
  GuestMask,
  type AdminRequiredMaskProps,
  type GuestMaskProps,
} from '@/components/auth/AccessMasks';
export {
  authReducer,
  initialAuthSnapshot,
  isAdminSnapshot,
  isGuestSnapshot,
  resolveAuthMode,
  type AuthEvent,
  type AuthSnapshot,
  type AuthStatus,
} from '@/components/auth/auth-machine';
export {
  ADMIN_REQUIRED_DESCRIPTION,
  ADMIN_REQUIRED_TITLE,
  CAPTCHA_FAILED_MESSAGE,
  CREDENTIAL_FAILED_MESSAGE,
  GUEST_MASK_DESCRIPTION,
  GUEST_MASK_TITLE,
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_CLOSED_REASON,
  SESSION_EXPIRED_NOTICE,
} from '@/components/auth/messages';
export {
  submitAuthForm,
  describeAuthFailure,
  shouldRefreshCaptcha,
  type AuthSubmission,
  type AuthSubmitDeps,
  type AuthSubmitOutcome,
} from '@/components/auth/auth-submit';
export {
  emptyAuthErrors,
  hasAuthErrors,
  validateAuthForm,
  type AuthFormErrors,
  type AuthFormValues,
} from '@/components/auth/validation';
