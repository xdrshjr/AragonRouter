import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/components/ui/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the field as failed: red border plus `aria-invalid`. */
  invalid?: boolean;
  /** Element rendered inside the field, before the text (e.g. a search icon). */
  leading?: ReactNode;
  /** Element rendered inside the field, after the text (e.g. a copy button). */
  trailing?: ReactNode;
  /** Monospaced, tabular text for keys, ids and numbers. */
  mono?: boolean;
  /** Full width by default; set false for compact inline fields. */
  block?: boolean;
}

/**
 * Text input. Always renders an accessible, focusable control: `invalid` only
 * changes the visuals and `aria-invalid`, never the semantics.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, leading, trailing, mono = false, block = true, className, ...rest },
  ref,
) {
  return (
    <div className={cn('relative flex items-center', block && 'w-full')}>
      {leading ? (
        <span className="pointer-events-none absolute left-2.5 flex items-center text-muted">{leading}</span>
      ) : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-9 w-full rounded-md border bg-surface-2 px-3 text-sm text-text',
          'placeholder:text-muted',
          'transition-colors duration-150 ease-console',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25',
          invalid ? 'border-danger focus:border-danger focus:ring-danger/25' : 'border-border-strong',
          leading && 'pl-8',
          trailing && 'pr-16',
          mono && 'mono text-xs',
          className,
        )}
        {...rest}
      />
      {trailing ? <span className="absolute right-1.5 flex items-center">{trailing}</span> : null}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded-md border bg-surface-2 px-3 py-2 text-sm text-text',
        'placeholder:text-muted',
        'transition-colors duration-150 ease-console',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25',
        invalid ? 'border-danger focus:border-danger focus:ring-danger/25' : 'border-border-strong',
        className,
      )}
      {...rest}
    />
  );
});

export interface FieldProps {
  label: ReactNode;
  /** Input id; generated when omitted so the label always points at the control. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode | ((ids: { id: string; describedBy: string | undefined }) => ReactNode);
  className?: string;
  /** Renders the label in the 11px uppercase style used by dense forms. */
  caps?: boolean;
}

/**
 * Label + control + hint/error composition with correct `aria-describedby`.
 * `children` may be a render prop when the control needs the generated id.
 */
export function Field({ label, htmlFor, hint, error, required = false, children, className, caps = false }: FieldProps): ReactNode {
  const generated = useId();
  const id = htmlFor ?? `field-${generated}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className={cn(caps ? 'label-caps block' : 'block text-xs font-medium text-text')}>
        {label}
        {required ? (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {typeof children === 'function' ? children({ id, describedBy }) : children}
      {error ? (
        // `role="alert"` is an assertive live region: the message is announced
        // when it appears (wrong password, failed validation), while
        // `aria-describedby` keeps it attached to the control afterwards. The
        // paragraph only exists while there is an error, so nothing is announced
        // on first render.
        <p id={errorId} role="alert" className="text-xs leading-5 text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
