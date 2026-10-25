import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border-strong bg-surface-2 text-muted',
  brand: 'border-brand/40 bg-[color:var(--brand-soft)] text-brand',
  success: 'border-brand/40 bg-[color:var(--brand-soft)] text-brand',
  warning: 'border-warning/40 bg-[color:var(--warning-soft)] text-warning',
  danger: 'border-danger/40 bg-[color:var(--danger-soft)] text-danger',
  info: 'border-info/40 bg-[color:var(--info-soft)] text-info',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Renders a 6px dot before the text (status indicators). */
  dot?: boolean;
  /** Monospaced content for status codes and identifiers. */
  mono?: boolean;
  size?: 'sm' | 'md';
}

/** Small status pill used for key state, HTTP status and provider health. */
export function Badge({
  tone = 'neutral',
  dot = false,
  mono = false,
  size = 'sm',
  className,
  children,
  ...rest
}: BadgeProps): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded border font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px] leading-4' : 'px-2 py-1 text-xs',
        mono && 'mono tabular',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
