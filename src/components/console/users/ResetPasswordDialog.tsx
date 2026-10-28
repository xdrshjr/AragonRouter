'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PASSWORD_HINT } from '@/components/auth/messages';
import { useAuth } from '@/components/auth/auth-context';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { useAsyncAction } from '@/components/console/use-admin-query';
import { resetUserPassword } from '@/components/console/api';
import { validateUserPassword, USER_PASSWORD_MAX_LENGTH } from '@/components/console/validation';
import type { UserPublic } from '@/components/console/types';
import { describeUserActionFailure } from '@/components/console/users/user-copy';
import { DialogActions, TextField } from '@/components/console/users/user-fields';

export interface ResetPasswordDialogProps {
  target: UserPublic | null;
  onClose: () => void;
  onDone: (user: UserPublic) => void;
}

/**
 * `POST /api/admin/users/[id]/password`: an administrator sets a password the account
 * does not have to know. The server revokes that account's other device sessions, so
 * the success toast tells the operator the target must sign in again.
 */
export function ResetPasswordDialog({
  target,
  onClose,
  onDone,
}: ResetPasswordDialogProps): ReactNode {
  const auth = useAuth();
  const action = useAsyncAction();
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const targetId = target?.id ?? null;

  useSessionExpiryRedirect(action.error);

  useEffect(() => {
    setPassword('');
    setPasswordError(null);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  const close = useCallback(() => {
    setPassword('');
    setPasswordError(null);
    action.reset();
    onClose();
  }, [action, onClose]);

  const submit = useCallback(async () => {
    if (!target) return;
    if (!auth.isAdmin) {
      auth.openLogin('login');
      return;
    }
    // The policy is checked against the target's username: the store refuses a
    // password that contains it, and so does this field.
    const problem = validateUserPassword(password, target.username);
    if (problem) {
      setPasswordError(problem);
      return;
    }
    setPasswordError(null);
    const result = await action.run(() => resetUserPassword(target.id, password));
    if (result === null) return;
    setPassword('');
    onDone(target);
  }, [action, auth, onDone, password, target]);

  return (
    <Modal
      open={target !== null}
      onClose={close}
      title={target ? `Reset the password of ${target.username}` : 'Reset password'}
      description={
        'Administrators set a new password without knowing the old one. Every other ' +
        'device session of the account is revoked.'
      }
      size="sm"
      busy={action.pending}
      error={action.error ? describeUserActionFailure(action.error) : null}
      footer={
        <DialogActions
          pending={action.pending}
          submitLabel="Reset password"
          loadingLabel="Resetting"
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
      >
        <TextField
          label="New password"
          hint={PASSWORD_HINT}
          error={passwordError}
          required
          name="newPassword"
          type="password"
          value={password}
          autoComplete="new-password"
          maxLength={USER_PASSWORD_MAX_LENGTH}
          autoFocus
          disabled={action.pending}
          onChange={(value) => {
            setPassword(value);
            setPasswordError(null);
            action.reset();
          }}
        />
      </form>
    </Modal>
  );
}
