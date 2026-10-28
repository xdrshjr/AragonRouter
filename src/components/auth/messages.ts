/**
 * Operator-facing copy of the account layer.
 *
 * Every string the sign-in dialog, the `/login` fallback and the console masks
 * show lives here, so the wording cannot drift between the three places that
 * render the same form. The console ships English copy only (see
 * `tests/ui/pages.test.ts`), which is why the acceptance phrases for the guest
 * mask and the admin-only notice are rendered in their English equivalents:
 * "sign in to view" and "administrator access required".
 */

/** Dialog and page heading while signing in. */
export const SIGN_IN_TITLE = 'Sign in';

/** Dialog and page heading while creating an account. */
export const REGISTER_TITLE = 'Create account';

/** Tab labels. */
export const SIGN_IN_TAB = 'Sign in';
export const REGISTER_TAB = 'Create account';

/** Shown when the visitor switched to the register tab while sign-ups are closed. */
export const REGISTRATION_CLOSED_REASON =
  'An administrator has closed sign-ups on this instance, so the register tab is unavailable. ' +
  'Ask an administrator to create an account for you.';

/** Client-side and server-side failure copy (kept out of the components). */
export const CREDENTIAL_FAILED_MESSAGE =
  'That username and password combination was not recognised.';
export const CAPTCHA_FAILED_MESSAGE =
  'That security code did not match. A fresh code has been generated, please try again.';
export const CAPTCHA_NOT_READY_MESSAGE =
  'The security code is still loading. Wait a moment, then submit again.';
export const REGISTRATION_CLOSED_MESSAGE =
  'Registration was refused because an administrator has closed sign-ups.';
export const THROTTLED_MESSAGE = 'Too many failed attempts. Wait a minute, then try again.';
export const NETWORK_FAILED_MESSAGE =
  'The console API could not be reached. Check that the server is running, then try again.';
export const GENERIC_FAILED_MESSAGE = 'That did not work. Try again.';

/** Announcement shown inside the dialog when the old session expired. */
export const SESSION_EXPIRED_NOTICE =
  'Your session expired. Sign in again to keep working where you left off.';

/** Guest shell mask. */
export const GUEST_MASK_TITLE = 'Sign in to view this panel';
export const GUEST_MASK_DESCRIPTION =
  'The console shell is open to everyone, but panel data comes from the administrator ' +
  'API. Sign in to load live keys, traffic and logs.';
export const GUEST_MASK_ACTION = 'Sign in';
export const GUEST_MASK_REGISTER_ACTION = 'Create an account';

/** Signed-in `member` mask (every console endpoint is admin-only). */
export const ADMIN_REQUIRED_TITLE = 'Administrator access required';
export const ADMIN_REQUIRED_DESCRIPTION =
  'This account is a member, and every console panel reads the administrator API. ' +
  'Ask an administrator to promote the account, or sign in with an admin account.';

/** Field labels and hints. */
export const USERNAME_LABEL = 'Username';
export const PASSWORD_LABEL = 'Password';
export const DISPLAY_NAME_LABEL = 'Display name';
export const CAPTCHA_LABEL = 'Security code';
export const CAPTCHA_HINT =
  'Type the five characters from the image. Click the image for a new code.';
export const USERNAME_HINT = '3-32 characters: letters, digits, dot, dash or underscore.';
export const PASSWORD_HINT = 'At least 8 characters with one letter and one digit.';
