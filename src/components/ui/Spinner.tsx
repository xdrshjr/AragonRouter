import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface SpinnerProps {
  /** Diameter in pixels. */
  size?: number;
  className?: string;
  /** Accessible label; set to `null` when a visible label already describes the state. */
  label?: string | null;
}

/**
 * A tiny inline SVG spinner. Uses `currentColor` so it inherits the surrounding
 * text colour and therefore works on every surface tone.
 */
export function Spinner({ size = 16, className, label = 'Loading' }: SpinnerProps): ReactNode {
  return (
    <svg
      className={cn('animate-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : 'presentation'}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface LoadingBlockProps {
  label?: string;
  className?: string;
}

/** Centred spinner plus caption, used while a whole panel is loading. */
export function LoadingBlock({ label = 'Loading', className }: LoadingBlockProps): ReactNode {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted', className)}>
      <Spinner size={16} label={null} />
      <span>{label}</span>
    </div>
  );
}
