import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/components/ui/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  invalid?: boolean;
  /** Options to render; `placeholder` becomes a leading disabled option. */
  options: readonly SelectOption[];
  placeholder?: string;
  block?: boolean;
}

/**
 * Native `<select>` styled with the C10 tokens.
 *
 * A native control is deliberate: it keeps OS-level keyboard and screen-reader
 * behaviour, survives zoom, and works before hydration.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, options, placeholder, block = true, className, ...rest },
  ref,
) {
  return (
    <div className={cn('relative', block && 'w-full')}>
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-9 w-full appearance-none rounded-md border bg-surface-2 pl-3 pr-8 text-sm text-text',
          'transition-colors duration-150 ease-console',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25',
          invalid ? 'border-danger focus:border-danger focus:ring-danger/25' : 'border-border-strong',
          className,
        )}
        {...rest}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

/** Convenience builder for a `<Select>` fed from a plain string list. */
export function toOptions(values: readonly string[], labelOf?: (value: string) => string): SelectOption[] {
  return values.map((value) => ({ value, label: labelOf ? labelOf(value) : value }));
}
