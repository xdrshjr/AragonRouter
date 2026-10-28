'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { PASSWORD_HINT, USERNAME_HINT } from '@/components/auth/messages';
import {
  USER_DISPLAY_NAME_MAX_LENGTH,
  USER_PASSWORD_MAX_LENGTH,
  USER_USERNAME_MAX_LENGTH,
} from '@/components/console/validation';

interface DialogActionsProps {
  pending: boolean;
  submitLabel: string;
  loadingLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
}

/** Cancel + submit pair every account dialog uses, so no dialog invents its own. */
export function DialogActions({
  pending,
  submitLabel,
  loadingLabel,
  onCancel,
  onSubmit,
}: DialogActionsProps): ReactNode {
  return (
    <>
      <Button variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={onSubmit}
        loading={pending}
        loadingLabel={loadingLabel}
      >
        {submitLabel}
      </Button>
    </>
  );
}

export interface TextFieldProps {
  label: string;
  hint?: string;
  error: string | null;
  required?: boolean;
  name: string;
  value: string;
  type?: 'text' | 'password';
  autoComplete: string;
  maxLength: number;
  autoFocus?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}

/** Label + input + inline error, bound through the kit's `Field` (aria wiring included). */
export function TextField({
  label,
  hint,
  error,
  required,
  name,
  value,
  type = 'text',
  autoComplete,
  maxLength,
  autoFocus,
  disabled,
  onChange,
}: TextFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          name={name}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          maxLength={maxLength}
          invalid={error !== null}
          aria-describedby={describedBy}
          disabled={disabled}
        />
      )}
    </Field>
  );
}

export interface SelectFieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  options: readonly SelectOption[];
  value: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** 11px uppercase label, used by the dense filter bar. */
  caps?: boolean;
  onChange: (value: string) => void;
}

/** Native select bound the same way, so no dialog repeats the `Field` render prop. */
export function SelectField({
  label,
  hint,
  error,
  options,
  value,
  disabled,
  ariaLabel,
  caps,
  onChange,
}: SelectFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint} error={error ?? null} caps={caps}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          options={options}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          disabled={disabled}
        />
      )}
    </Field>
  );
}

export interface CreateFieldSpec {
  key: 'username' | 'displayName' | 'password';
  label: string;
  hint: string;
  type: 'text' | 'password';
  autoComplete: string;
  maxLength: number;
  required: boolean;
}

/** The three text fields of the create dialog, in the order an operator expects. */
export const CREATE_FIELDS: readonly CreateFieldSpec[] = [
  {
    key: 'username',
    label: 'Username',
    hint: USERNAME_HINT,
    type: 'text',
    autoComplete: 'off',
    // Mirrors the store's limit so the input cannot accept a name the API would 400.
    maxLength: USER_USERNAME_MAX_LENGTH,
    required: true,
  },
  {
    key: 'displayName',
    label: 'Display name',
    hint: 'Optional. Shown in the top bar and in this list.',
    type: 'text',
    autoComplete: 'off',
    maxLength: USER_DISPLAY_NAME_MAX_LENGTH,
    required: false,
  },
  {
    key: 'password',
    label: 'Password',
    hint: PASSWORD_HINT,
    type: 'password',
    autoComplete: 'new-password',
    // Same bound as the validator and `src/lib/password.ts` - one constant, no drift.
    maxLength: USER_PASSWORD_MAX_LENGTH,
    required: true,
  },
];
