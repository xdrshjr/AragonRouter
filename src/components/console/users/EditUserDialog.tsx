'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/components/auth/auth-context';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { useAsyncAction } from '@/components/console/use-admin-query';
import { updateUser } from '@/components/console/api';
import {
  USER_DISPLAY_NAME_MAX_LENGTH,
  buildUpdateUserPayload,
  emptyUserEditErrors,
  hasUserEditErrors,
  userEditValuesOf,
  validateUserEditForm,
  type UserEditErrors,
  type UserEditValues,
} from '@/components/console/validation';
import type { UserPublic, UserRole, UserStatus } from '@/components/console/types';
import {
  describeUserActionFailure,
  ROLE_OPTIONS,
  STATUS_OPTIONS,
} from '@/components/console/users/user-copy';
import { DialogActions, SelectField, TextField } from '@/components/console/users/user-fields';

export interface EditUserDialogProps {
  target: UserPublic | null;
  currentUserId: string | null;
  onClose: () => void;
  onSaved: (user: UserPublic) => void;
}

const EMPTY_EDIT_VALUES: UserEditValues = { displayName: '', role: 'member', status: 'active' };

/**
 * `PATCH /api/admin/users/[id]`: display name, role and status of one account.
 *
 * The store refuses the two rules that lock an instance out - "you cannot remove your
 * own admin role" and "at least one active admin must remain" - so those refusals are
 * rendered verbatim (translated) in the dialog, and the self row carries a warning
 * before the attempt is even made.
 */
export function EditUserDialog({
  target,
  currentUserId,
  onClose,
  onSaved,
}: EditUserDialogProps): ReactNode {
  const auth = useAuth();
  const action = useAsyncAction();
  const [values, setValues] = useState<UserEditValues>(() =>
    target ? userEditValuesOf(target) : EMPTY_EDIT_VALUES,
  );
  const [errors, setErrors] = useState<UserEditErrors>(emptyUserEditErrors());
  const targetId = target?.id ?? null;

  useSessionExpiryRedirect(action.error);

  // Re-seed the form whenever a different row opens the dialog. `action.reset` is
  // deliberately not a dependency: running this on every action change would wipe an
  // edit that is still in flight.
  useEffect(() => {
    if (!target) return;
    setValues(userEditValuesOf(target));
    setErrors(emptyUserEditErrors());
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  const close = useCallback(() => {
    setErrors(emptyUserEditErrors());
    action.reset();
    onClose();
  }, [action, onClose]);

  const editField = useCallback(
    (patch: Partial<UserEditValues>) => {
      setValues((current) => ({ ...current, ...patch }));
      action.reset();
    },
    [action],
  );

  const submit = useCallback(async () => {
    if (!target) return;
    if (!auth.isAdmin) {
      auth.openLogin('login');
      return;
    }
    const found = validateUserEditForm(values);
    if (hasUserEditErrors(found)) {
      setErrors(found);
      return;
    }
    setErrors(emptyUserEditErrors());
    const saved = await action.run(() => updateUser(target.id, buildUpdateUserPayload(values)));
    if (!saved) return;
    onSaved(saved);
  }, [action, auth, onSaved, target, values]);

  const isSelf = target !== null && currentUserId !== null && target.id === currentUserId;

  return (
    <Modal
      open={target !== null}
      onClose={close}
      title={target ? `Edit ${target.username}` : 'Edit account'}
      description={
        'The username is permanent. Role and status are enforced by the API: the last ' +
        'active admin and your own account are protected.'
      }
      size="md"
      busy={action.pending}
      error={action.error ? describeUserActionFailure(action.error) : null}
      footer={
        <DialogActions
          pending={action.pending}
          submitLabel="Save changes"
          loadingLabel="Saving"
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
        <TextField
          label="Display name"
          hint="Leave empty to remove the display name."
          error={errors.displayName}
          name="displayName"
          value={values.displayName}
          autoComplete="off"
          maxLength={USER_DISPLAY_NAME_MAX_LENGTH}
          disabled={action.pending}
          onChange={(value) => {
            setValues((current) => ({ ...current, displayName: value }));
            setErrors((current) => ({ ...current, displayName: null }));
            action.reset();
          }}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Role"
            error={errors.role}
            options={ROLE_OPTIONS}
            value={values.role}
            disabled={action.pending}
            onChange={(value) => {
              editField({ role: value as UserRole });
            }}
          />
          <SelectField
            label="Status"
            error={errors.status}
            options={STATUS_OPTIONS}
            value={values.status}
            disabled={action.pending}
            onChange={(value) => {
              editField({ status: value as UserStatus });
            }}
          />
        </div>
        {isSelf ? (
          <p
            className={
              'rounded-md border border-warning/40 bg-[color:var(--warning-soft)] ' +
              'px-2.5 py-2 text-[11px] leading-4 text-text'
            }
          >
            This is your own account. Disabling it or removing its admin role is refused by the
            server, and the last active admin can never be demoted or switched off.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
