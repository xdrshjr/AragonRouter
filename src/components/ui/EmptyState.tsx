import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface EmptyStateProps {
  /** Icon element (lucide icon rendered at 20-24px). */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Primary call to action. */
  action?: ReactNode;
  /** Denser padding for an empty state that lives inside a card. */
  compact?: boolean;
  className?: string;
}

/** Neutral placeholder shown when a list has no rows yet. */
export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="mb-1 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-2 text-muted"
        >
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium text-text">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-5 text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Failure placeholder used whenever an admin request cannot be completed. */
export function ErrorState({ title = 'Something went wrong', message, action, compact = false, className }: ErrorStateProps): ReactNode {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-danger/40 bg-[color:var(--danger-soft)] text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        className,
      )}
    >
      <p className="text-sm font-medium text-danger">{title}</p>
      <p className="max-w-md text-xs leading-5 text-text">{message}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
