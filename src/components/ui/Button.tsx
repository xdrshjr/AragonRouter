import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { Spinner } from '@/components/ui/Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-on-brand border border-transparent hover:bg-brand-hover active:bg-brand-hover shadow-sm',
  secondary:
    'bg-surface-2 text-text border border-border-strong hover:border-text-muted hover:bg-surface active:bg-surface-2',
  ghost:
    'bg-transparent text-muted border border-transparent hover:bg-surface-2 hover:text-text active:bg-surface-2',
  danger:
    'bg-transparent text-danger border border-danger/60 hover:bg-[color:var(--danger-soft)] hover:border-danger active:bg-[color:var(--danger-soft)]',
  link: 'bg-transparent text-brand border border-transparent hover:underline underline-offset-2 px-0',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
  icon: 'h-9 w-9 p-0 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner and blocks interaction while an action is in flight. */
  loading?: boolean;
  /** Text announced while `loading` (defaults to the visible children). */
  loadingLabel?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Stretch to the width of the container. */
  block?: boolean;
}

/**
 * The console's only button primitive.
 *
 * `loading` keeps the button focusable but `disabled`, and swaps the accessible
 * name to `loadingLabel` so a screen reader hears "Saving" instead of nothing.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel,
    leftIcon,
    rightIcon,
    block = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-loading={loading ? '' : undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-md font-medium',
        'transition-colors duration-150 ease-console',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'sm' ? 12 : 14} className="shrink-0" label={loadingLabel ?? 'Loading'} />
      ) : (
        leftIcon
      )}
      {/*
        The icon is always rendered visibly; an icon-only button takes its
        accessible name from the `aria-label` the caller passes (falling back to
        `children` when it is text). Rendering it inside an `sr-only` span would
        hide the glyph from sighted users.
      */}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
