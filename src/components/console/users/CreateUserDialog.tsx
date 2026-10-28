'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/components/auth/auth-context';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { useAsyncAction } from '@/components/console/use-admin-query';
import { createUser } from '@/components/console/api';
import {
  EMPTY_USER_FORM,
  buildCreateUserPayload,
  emptyUserFormErrors,
  hasUserFormErrors,
  validateUserForm,
  type UserFormErrors,
  type UserFormValues,
} from '@/components/console/validation';
import type { UserPublic, UserRole } from '@/components/console/types';
import { describeUserActionFailure, ROLE_OPTIONS } from '@/components/console/users/user-copy';
import {
  CREATE_FIELDS,
  DialogActions,
  SelectField,
  TextField,
} from '@/components/console/users/user-fields';

export interface CreateUserDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (user: UserPublic) => void;
}

/**
 * `POST /api/admin/users` behind a dialog.
 *
 * The client validates first with the same rules the store enforces
 * (`validation.ts`), so a weak password or a malformed username is reported next to
 * the field instead of after a round trip; the server stays the authority, and its
 * own refusal (duplicate name, missing digit) is rendered through
 * `describeUserActionFailure` when the two ever disagree.
 */
export function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: CreateUserDialogProps): ReactNode {
  const auth = useAuth();
  const action = useAsyncAction();
  const [values, setValues] = useState<UserFormValues>(EMPTY_USER_FORM);
  const [errors, setErrors] = useState<UserFormErrors>(emptyUserFormErrors());

  useSessionExpiryRedirect(action.error);

  // The app shell hides this dialog from a `member`; the guard keeps the single
  // "open the sign-in dialog" rule even if a future shell forgets to.
  const isBlocked = !auth.isAdmin;

  const close = useCallback(() => {
    setValues(EMPTY_USER_FORM);
    setErrors(emptyUserFormErrors());
    action.reset();
    onClose();
  }, [action, onClose]);

  const updateField = useCallback(
    (key: 'username' | 'displayName' | 'password', value: string) => {
      setValues((current) => ({ ...current, [key]: value }));
      setErrors((current) => ({ ...current, [key]: null }));
      action.reset();
    },
    [action],
  );

  const updateRole = useCallback(
    (value: string) => {
      setValues((current) => ({ ...current, role: value as UserRole }));
      action.reset();
    },
    [action],
  );

  const submit = useCallback(async () => {
    if (isBlocked) {
      auth.openLogin('login');
      return;
    }
    const found = validateUserForm(values);
    if (hasUserFormErrors(found)) {
      setErrors(found);
      return;
    }
    setErrors(emptyUserFormErrors());
    const created = await action.run(() => createUser(buildCreateUserPayload(values)));
    if (!created) return;
    setValues(EMPTY_USER_FORM);
    setErrors(emptyUserFormErrors());
    onCreated(created);
  }, [action, auth, isBlocked, onCreated, values]);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Create an account"
      description={
        'The account can sign in immediately. The role decides whether it may use this console.'
      }
      size="md"
      busy={action.pending}
      error={action.error ? describeUserActionFailure(action.error) : null}
      footer={
        <DialogActions
          pending={action.pending}
          submitLabel="Create account"
          loadingLabel="Creating"
          onCancel={close}
          onSubmit={() => {
            void submit();
          }}
        />
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
        className="space-y-3"
      >
        {CREATE_FIELDS.map((field) => (
          <TextField
            key={field.key}
            label={field.label}
            hint={field.hint}
            error={errors[field.key]}
            required={field.required}
            name={field.key}
            value={values[field.key]}
            type={field.type}
            autoComplete={field.autoComplete}
            maxLength={field.maxLength}
            autoFocus={field.key === 'username'}
            disabled={action.pending}
            onChange={(value) => updateField(field.key, value)}
          />
        ))}
        <SelectField
          label="Role"
          hint="Members can sign in but cannot use the console."
          error={errors.role}
          options={ROLE_OPTIONS}
          value={values.role}
          disabled={action.pending}
          onChange={updateRole}
        />
      </form>
    </Modal>
  );
}
