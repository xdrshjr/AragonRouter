'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name. Required: a switch without a name is unusable with a screen reader. */
  label: string;
  /**
   * Element id. Pass the one produced by a `Field` render prop so the surrounding
   * `<label htmlFor>` points at the switch instead of at a non-existent element.
   */
  id?: string;
  /**
   * Ids of the elements describing this switch (a `Field` hint or error), applied
   * as `aria-describedby` on the switch button.
   */
  describedBy?: string;
  /** Visible text rendered next to the track and bound to it with `<label htmlFor>`. */
  description?: ReactNode;
  disabled?: boolean;
  /** Shows a pulsing thumb while the change is being persisted. */
  pending?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/**
 * Accessible on/off switch (`role="switch"` + `aria-checked`).
 *
 * A `<button>` gives Space and Enter for free; Enter is handled explicitly only
 * because a `<button role="switch">` inside a table row may otherwise bubble into
 * a row-level click handler.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  id,
  describedBy,
  description,
  disabled = false,
  pending = false,
  className,
  size = 'md',
}: SwitchProps): ReactNode {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const isDisabled = disabled || pending;
  const track = size === 'sm' ? 'h-[18px] w-8' : 'h-5 w-9';
  const thumb = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const shift = size === 'sm' ? 'translate-x-3.5' : 'translate-x-4';

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={describedBy}
        // A native <button> activates on Space and Enter, so no key handler is
        // added: doing so would toggle twice on Enter and cancel itself out.
        aria-label={description ? undefined : label}
        title={label}
        disabled={isDisabled}
        onClick={() => {
          onCheckedChange(!checked);
        }}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full border p-0.5 transition-colors duration-150 ease-console',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          'disabled:cursor-not-allowed disabled:opacity-50',
          track,
          checked ? 'border-brand bg-brand' : 'border-border-strong bg-surface-2',
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block transform rounded-full transition-transform duration-150 ease-console',
            thumb,
            pending && 'animate-pulse',
            checked ? `${shift} bg-on-brand` : 'translate-x-0 bg-text-muted',
          )}
        />
      </button>
      {description ? (
        <label
          htmlFor={switchId}
          className={cn(
            'cursor-pointer text-sm leading-5 text-text',
            isDisabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {description}
        </label>
      ) : null}
    </div>
  );
}
