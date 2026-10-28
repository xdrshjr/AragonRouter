/**
 * Cross-module boundary (WP users-admin-ui x admin-users-api x auth-api): the console's
 * account forms against the *real* `/api/admin/users/**` and `/api/auth/login` handlers.
 *
 * Acceptance 3 asks the create dialog to "validate by the server rules", and acceptance 4
 * asks the edit/reset dialogs to work with the server's refusals. The existing suite
 * proves those claims by reading the shared predicates; this file proves them by
 * comparing the client gate with the live handler in both directions:
 *
 *  - **never looser** - every value the dialog accepts must be accepted by the server, so
 *    an operator is never told "fine" and then refused after a round trip;
 *  - **never silent** - every value the dialog refuses is refused by the server too (or
 *    the client is *stricter*, which is asserted explicitly for the display name), so the
 *    inline message is not inventing a rule the API does not have.
 *
 * It also pins the two promises the dialogs make in prose: the username is permanent
 * (a tampered PATCH body cannot rename an account) and the create dialog cannot smuggle
 * the fields it does not show (status, id, password hash, timestamps).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createUser,
  getUser,
  listUsers,
  login,
  resetUserPassword,
  updateUser,
} from '@/components/console/api';
import type { UpdateUserPayload, UserPublic } from '@/components/console/types';
import { UsersTable } from '@/components/console/users/UsersTable';
import {
  EMPTY_USER_FORM,
  USER_DISPLAY_NAME_MAX_LENGTH,
  buildCreateUserPayload,
  buildUpdateUserPayload,
  describeUserRuleMessage,
  hasUserFormErrors,
  validateUserForm,
  validateUserPassword,
} from '@/components/console/validation';
import type { UserFormValues } from '@/components/console/validation';
import { createCaptcha } from '@/lib/captcha';
import {
  BASE_URL,
  TEST_ADMIN_PASSWORD,
  installAdminHarness,
  prepareGatewayEnv,
} from '../ui/support/admin-harness';
import type { AdminHarness } from '../ui/support/admin-harness';

/** A challenge whose answer this test knows (the HTTP layer never chooses it). */
function solvedCaptcha(answer = 'ABCDE'): { challengeId: string; answer: string } {
  const challenge = createCaptcha(Date.now(), { answer });
  return { challengeId: challenge.id, answer };
}

/** Sign in through the real login route with a freshly minted captcha. */
function signIn(username: string, password: string): Promise<UserPublic> {
  const captcha = solvedCaptcha();
  return login({
    username,
    password,
    challengeId: captcha.challengeId,
    captchaAnswer: captcha.answer,
  });
}

function signInAsAdmin(): Promise<UserPublic> {
  return signIn('admin', TEST_ADMIN_PASSWORD);
}

/** A password with a letter and a digit and no username fragment, of an exact length. */
function passwordOfLength(length: number): string {
  return `Q${'x'.repeat(Math.max(0, length - 2))}1`;
}

/** What the create dialog would send for these values, and what the server answered. */
type CreateOutcome =
  | { ok: true; user: UserPublic }
  | { ok: false; error: ApiError };

async function attemptCreate(values: UserFormValues): Promise<CreateOutcome> {
  try {
    return { ok: true, user: await createUser(buildCreateUserPayload(values)) };
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return { ok: false, error: error as ApiError };
  }
}

/** The password matrix both the create and the reset form are driven with. */
const PASSWORD_CANDIDATES: readonly { password: string; note: string; owner?: string }[] = [
  { password: '', note: 'empty' },
  { password: 'short1', note: 'seven characters' },
  { password: 'lettersonly', note: 'no digit' },
  { password: '12345678', note: 'no letter' },
  { password: 'member-one-9', note: 'contains the username', owner: 'member-one' },
  { password: 'MEMBER-ONE-9', note: 'contains the username in another case', owner: 'member-one' },
  { password: 'Quiet-H4rbour-1', note: 'valid' },
  { password: passwordOfLength(200), note: 'exactly the upper bound' },
  { password: passwordOfLength(201), note: 'one over the upper bound' },
  { password: passwordOfLength(300), note: 'far over the upper bound' },
];

/** Usernames the dialog must classify exactly like `validateUsername` does. */
const USERNAME_CANDIDATES: readonly string[] = [
  '',
  'ab',
  'a'.repeat(33),
  '-lead',
  '.dot',
  'a b',
  'Ünicode',
  'ok.name',
  'ok-name',
  'ok_name',
  ' spaced-name ',
  'CaseName',
];

describe('acceptance 3: the create gate is never looser than the real handler', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('accepts every username the server accepts, and refuses none it accepts', async () => {
    await signInAsAdmin();

    for (const username of USERNAME_CANDIDATES) {
      const values: UserFormValues = { ...EMPTY_USER_FORM, username, password: 'Quiet-H4rbour-1' };
      const blocked = hasUserFormErrors(validateUserForm(values));
      const outcome = await attemptCreate(values);

      if (!blocked) {
        // The dangerous direction: a green field that turns into a 400.
        expect(outcome.ok, `the dialog accepted "${username}" but the server refused it`).toBe(
          true,
        );
        if (outcome.ok) {
          // ... and what landed is what was typed, minus the documented trim.
          expect(outcome.user.username).toBe(username.trim());
          expect(outcome.user.role).toBe('member');
          expect(outcome.user.status).toBe('active');
        }
      } else {
        // A blocked name must be one the store refuses as well: the inline message is a
        // mirror, not a rule the client invented.
        expect(outcome.ok, `the dialog refused "${username}" but the server accepted it`).toBe(
          false,
        );
        if (!outcome.ok) {
          expect(outcome.error.status).toBe(400);
          expect(describeUserRuleMessage(outcome.error.message)).not.toBe(
            outcome.error.message,
          );
        }
      }
    }
  });

  it('accepts every password the server accepts, and refuses none it accepts', async () => {
    await signInAsAdmin();

    for (const [index, { password, note, owner }] of PASSWORD_CANDIDATES.entries()) {
      // One fresh account per candidate: "username is already taken" must not be what
      // makes an accepted password look refused.
      const username = owner ?? `parity-${index}`;
      const values: UserFormValues = { ...EMPTY_USER_FORM, username, password };
      const clientMessage = validateUserForm(values).password;
      const outcome = await attemptCreate(values);

      if (clientMessage === null) {
        expect(outcome.ok, `${note}: the dialog accepted a password the server refused`).toBe(
          true,
        );
        if (outcome.ok) {
          // The account really can sign in with exactly these bytes: the hash is of the
          // value that was typed, with nothing trimmed or normalised on the way.
          const signedIn = await signIn(username, password);
          expect(signedIn.id).toBe(outcome.user.id);
          await signInAsAdmin();
        }
      } else {
        expect(outcome.ok, `${note}: the dialog refused a password the server accepted`).toBe(
          false,
        );
        if (!outcome.ok) {
          expect(outcome.error.status).toBe(400);
          // Every refusal the form can show has operator copy behind it.
          const copy = describeUserRuleMessage(outcome.error.message);
          expect(copy.charAt(0)).toBe(copy.charAt(0).toUpperCase());
        }
      }
    }
  });

  it('is stricter than the server only where being stricter cannot mislead', async () => {
    await signInAsAdmin();

    // A display name with a control character: the dialog refuses it, the store strips
    // the character and accepts the rest. Client-stricter is the safe direction, and it
    // is asserted instead of assumed.
    const raw = 'Operator\u0001Name';
    const values: UserFormValues = {
      ...EMPTY_USER_FORM,
      username: 'control-name',
      password: 'Quiet-H4rbour-1',
      displayName: raw,
    };
    expect(validateUserForm(values).displayName).not.toBeNull();

    const outcome = await attemptCreate(values);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.user.displayName).toBe('OperatorName');
    }

    // A display name over the budget is refused by BOTH, and the copy names the number.
    const tooLong = 'x'.repeat(USER_DISPLAY_NAME_MAX_LENGTH + 1);
    expect(validateUserForm({ ...values, displayName: tooLong }).displayName).toContain('64');
    const refused = await attemptCreate({ ...values, username: 'long-name', displayName: tooLong });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(describeUserRuleMessage(refused.error.message)).toBe(
        'The display name must be at most 64 characters.',
      );
    }
  });

  it('round-trips CJK, an emoji and the exact 64-character boundary into the table', async () => {
    await signInAsAdmin();
    const display = '运维 值班 🚀';
    const created = await createUser({
      username: 'duty-one',
      password: 'Quiet-H4rbour-1',
      displayName: display,
    });
    expect(created.displayName).toBe(display);

    const atBoundary = await createUser({
      username: 'boundary-one',
      password: 'Quiet-H4rbour-1',
      displayName: 'x'.repeat(USER_DISPLAY_NAME_MAX_LENGTH),
    });
    expect(atBoundary.displayName).toHaveLength(USER_DISPLAY_NAME_MAX_LENGTH);

    // The list the panel reloads after a create is the one that carries the value back.
    const page = await listUsers({ search: '值班' });
    expect(page.data.map((row) => row.id)).toEqual([created.id]);

    const markup = renderToStaticMarkup(
      <UsersTable
        rows={page.data}
        currentUserId={null}
        onEdit={() => undefined}
        onResetPassword={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(markup).toContain(display);
    expect(markup).toContain('duty-one');
  });
});

describe('acceptance 4: the fields the dialogs promise to own are the fields the API reads', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('cannot rename an account: the username stays exactly as created', async () => {
    await signInAsAdmin();
    const member = await createUser({
      username: 'stable-name',
      password: 'Quiet-H4rbour-1',
      displayName: 'Stable',
    });

    // The edit dialog's own payload never mentions the username ("The username is
    // permanent", EditUserDialog).
    const payload = buildUpdateUserPayload({
      displayName: 'Stable One',
      role: 'member',
      status: 'active',
    });
    expect(Object.keys(payload)).toEqual(['displayName', 'role', 'status']);
    const saved = await updateUser(member.id, payload);
    expect(saved.username).toBe('stable-name');
    expect(saved.displayName).toBe('Stable One');

    // Even a tampered body (a hand-edited request, a future dialog bug) cannot rename it:
    // the handler reads the three documented fields only.
    const tampered = await updateUser(member.id, {
      ...payload,
      username: 'renamed',
    } as UpdateUserPayload);
    expect(tampered.username).toBe('stable-name');

    const detail = await getUser(member.id);
    expect(detail.username).toBe('stable-name');
    expect(Array.isArray(detail.sessions)).toBe(true);

    // The injected name never became an account, and the real one still signs in - with
    // either case, because the lookup is case-insensitive while the stored name is not.
    const refused = await signIn('renamed', 'Quiet-H4rbour-1').catch((error: unknown) => error);
    expect((refused as ApiError).status).toBe(401);
    await expect(signIn('STABLE-NAME', 'Quiet-H4rbour-1')).resolves.toMatchObject({
      username: 'stable-name',
    });
  });

  it('ignores create-body fields the create dialog cannot send', async () => {
    await signInAsAdmin();
    const injectedHash = `scrypt$16384,8,1$${'00'.repeat(16)}$${'11'.repeat(64)}`;

    // Bypass the typed client on purpose: this is the hand-edited request a tampered
    // console (or a hostile script holding a stolen cookie) could send.
    const response = await harness.fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'injected-one',
        password: 'Quiet-H4rbour-1',
        role: 'member',
        // None of the following is part of C-USERS-WIRE's create body.
        id: 'chosen-id',
        status: 'disabled',
        passwordHash: injectedHash,
        lastLoginAt: '2000-01-01T00:00:00.000Z',
        sessionToken: 'attacker-chosen',
      }),
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    // A hash, a session token or a caller-chosen id must never come back.
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain(injectedHash);
    expect(text).not.toContain('sessionToken');
    expect(text).not.toContain('chosen-id');
    expect(text).not.toContain('attacker-chosen');

    const body = JSON.parse(text) as { data: UserPublic };
    expect(body.data.status).toBe('active');
    expect(body.data.lastLoginAt).toBeNull();
    expect(body.data.id).not.toBe('chosen-id');

    // The password in the body (not the injected hash) is the one that works.
    await expect(signIn('injected-one', 'Quiet-H4rbour-1')).resolves.toMatchObject({
      username: 'injected-one',
    });
  });

  it('refuses an unknown account with the copy the delete confirmation shows', async () => {
    await signInAsAdmin();
    const member = await createUser({
      username: 'gone-one',
      password: 'Quiet-H4rbour-1',
    });
    await updateUser(member.id, { displayName: null, role: 'member', status: 'active' });

    const outcome = await updateUser('no-such-id', {
      displayName: null,
      role: 'member',
      status: 'active',
    }).catch((error: unknown) => error);
    expect((outcome as ApiError).status).toBe(404);
    expect(describeUserRuleMessage((outcome as ApiError).message)).toBe(
      'That account no longer exists. Refresh the list and try again.',
    );
  });

  /**
   * The dialogs promise to show "the server's own wording, translated". That promise is
   * only worth anything if *every* sentence the account API can actually emit has a
   * translation - so the list below is not hand-written, it is collected from the live
   * handlers, and each collected sentence is asserted to change on the way to the screen.
   */
  it('translates every refusal the API can raise, so none reaches the operator raw', async () => {
    await signInAsAdmin();
    await createUser({ username: 'taken-one', password: 'Quiet-H4rbour-1' });
    const member = await createUser({ username: 'plain-one', password: 'Quiet-H4rbour-1' });

    const messages: string[] = [];
    const collect = async (promise: Promise<unknown>): Promise<ApiError> => {
      const failure = await promise.then(
        () => null,
        (error: unknown) => error as ApiError,
      );
      expect(failure, 'this call was expected to be refused').toBeInstanceOf(ApiError);
      messages.push((failure as ApiError).message);
      return failure as ApiError;
    };

    await collect(createUser({ username: 'taken-one', password: 'Quiet-H4rbour-1' }));
    await collect(createUser({ username: '-bad', password: 'Quiet-H4rbour-1' }));
    await collect(createUser({ username: 'weak-one', password: 'short1' }));
    await collect(createUser({ username: 'weak-one', password: 'with-weak-one-1' }));
    await collect(createUser({ username: 'role-one', password: 'Quiet-H4rbour-1' }).then(
      // A role the form cannot produce but a tampered body can.
      async (created) => updateUser(created.id, { role: 'owner' as unknown as 'admin' }),
    ));
    await collect(
      updateUser(member.id, {
        displayName: 'x'.repeat(USER_DISPLAY_NAME_MAX_LENGTH + 1),
        role: 'member',
        status: 'active',
      }),
    );
    await collect(
      updateUser(member.id, {
        displayName: 42 as unknown as string,
        role: 'member',
        status: 'active',
      }),
    );
    await collect(getUser('no-such-id'));
    await collect(resetUserPassword('no-such-id', 'Quiet-H4rbour-1'));

    // The two enum refusals of a PATCH need a raw body: no typed client call sends them.
    for (const body of [{ role: 'owner' }, { status: 'ghost' }]) {
      const response = await harness.fetch(`${BASE_URL}/api/admin/users/${member.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, `PATCH ${JSON.stringify(body)}`).toBe(400);
      const parsed = (await response.json()) as { error: { message: string } };
      messages.push(parsed.error.message);
    }

    // Guard against a vacuous loop: the matrix really produced refusals.
    expect(messages.length).toBeGreaterThanOrEqual(10);
    for (const message of messages) {
      const copy = describeUserRuleMessage(message);
      expect(copy, `raw API sentence would reach the operator: ${message}`).not.toBe(message);
      expect(copy.charCodeAt(0)).toBeGreaterThan(64);
    }
  });
});

describe('acceptance 4: the reset-password dialog and the endpoint agree on the policy', () => {
  let harness: AdminHarness;

  beforeEach(() => {
    prepareGatewayEnv();
    harness = installAdminHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('rejects exactly the passwords the dialog rejects, for the target username', async () => {
    await signInAsAdmin();
    const member = await createUser({
      username: 'member-one',
      password: 'Quiet-H4rbour-1',
    });

    for (const { password, note } of PASSWORD_CANDIDATES) {
      const clientMessage = validateUserPassword(password, member.username);
      const outcome = await resetUserPassword(member.id, password).then(
        () => null,
        (error: unknown) => error as ApiError,
      );

      if (clientMessage === null) {
        expect(outcome, `${note}: the dialog allowed a reset the server refused`).toBeNull();
      } else {
        expect(outcome, `${note}: the dialog refused a reset the server allowed`).not.toBeNull();
        expect(outcome?.status).toBe(400);
      }
    }

    // The last accepted reset is the password the account now has, and the refused ones
    // really were never stored.
    await expect(signIn('member-one', passwordOfLength(201))).rejects.toBeInstanceOf(ApiError);
    await expect(signIn('member-one', passwordOfLength(300))).rejects.toBeInstanceOf(ApiError);
    expect(validateUserPassword(passwordOfLength(201), 'member-one')).toContain('at most 200');
    await expect(signIn('member-one', passwordOfLength(200))).resolves.toMatchObject({
      username: 'member-one',
    });
  });
});
