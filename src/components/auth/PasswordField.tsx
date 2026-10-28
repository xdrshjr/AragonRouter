'use client';

import { useState, type ReactNode, type Ref } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/Input';

/** Show/hide affordance inside the password field. */
const TOGGLE_CLASS =
  'rounded p-1 text-muted transition-colors hover:bg-surface hover:text-text ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export interface PasswordFieldProps {
  /** id of the generated label (`Field` hands it over). */
  id: string;
  /** `aria-describedby` from `Field` (error and/or hint ids). */
  describedBy?: string;
  value: string;
  onChange: (value: string) => void;
  /** `current-password` when signing in, `new-password` when registering. */
  autoComplete: 'current-password' | 'new-password';
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * Password control with a show/hide toggle.
 *
 * The toggle is a real `button[aria-pressed]` (not a clickable icon) so the state
 * is announced, and the value is only ever rendered by the browser's own input -
 * never as text in the DOM, never in the server markup.
 */
export function PasswordField({
  id,
  describedBy,
  value,
  onChange,
  autoComplete,
  invalid = false,
  disabled = false,
  placeholder,
  inputRef,
}: PasswordFieldProps): ReactNode {
  const [visible, setVisible] = useState(false);

  return (
    <Input
      id={id}
      ref={inputRef}
      type={visible ? 'text' : 'password'}
      name="password"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      autoComplete={autoComplete}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      placeholder={placeholder}
      invalid={invalid}
      aria-describedby={describedBy}
      disabled={disabled}
      trailing={
        <button
          type="button"
          onClick={() => {
            setVisible((current) => !current);
          }}
          disabled={disabled}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className={TOGGLE_CLASS}
        >
          {visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      }
    />
  );
}
