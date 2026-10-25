import type { LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /** Shows the required marker and `aria-required` hint on the label text. */
  required?: boolean;
  /** Renders in the 11px uppercase section style (C10). */
  caps?: boolean;
  /** Muted helper rendered under the label. */
  hint?: ReactNode;
}

/**
 * Standalone label for controls that cannot use `Field` (checkboxes, switches,
 * radio groups). `Field` is preferred for normal form inputs.
 */
export function Label({ required = false, caps = false, hint, className, children, ...rest }: LabelProps): ReactNode {
  return (
    <label
      className={cn(
        caps ? 'label-caps block' : 'block text-xs font-medium text-text',
        'select-none',
        className,
      )}
      {...rest}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      ) : null}
      {hint ? <span className="mt-1 block text-xs font-normal text-muted">{hint}</span> : null}
    </label>
  );
}
