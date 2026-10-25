import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds hover affordances for cards that are entirely clickable. */
  interactive?: boolean;
  /** Removes the inner padding (tables render edge to edge). */
  flush?: boolean;
}

/**
 * Surface container (C10: 8px radius, `--surface` background, 1px `--border`).
 * `flush` omits padding so a `Table` can own the full card width.
 */
export function Card({
  interactive = false,
  flush = false,
  className,
  children,
  ...rest
}: CardProps): ReactNode {
  return (
    <div
      className={cn(
        'rounded-card border border-border bg-surface shadow-card',
        interactive && 'transition-colors duration-150 ease-console hover:border-border-strong',
        !flush && 'p-4',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Right-aligned actions, controls or badges. */
  actions?: ReactNode;
  /** Render the title row with a bottom hairline. */
  divided?: boolean;
}

export function CardHeader({ actions, divided = false, className, children, ...rest }: CardHeaderProps): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3',
        divided && 'border-b border-border pb-3',
        className,
      )}
      {...rest}
    >
      <div className="min-w-0">{children}</div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Small muted line under the title. */
  description?: ReactNode;
  /** Render a 11px uppercase section label instead of a heading. */
  eyebrow?: string;
}

export function CardTitle({ description, eyebrow, className, children, ...rest }: CardTitleProps): ReactNode {
  return (
    <div className={cn('space-y-1', className)} {...rest}>
      {eyebrow ? <p className="label-caps">{eyebrow}</p> : null}
      <h2 className="text-base font-semibold leading-6 text-text">{children}</h2>
      {description ? <p className="text-xs leading-5 text-muted">{description}</p> : null}
    </div>
  );
}

export function CardContent({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div className={cn('mt-3', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
