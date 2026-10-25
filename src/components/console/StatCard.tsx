import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { Card } from '@/components/ui/Card';

export type StatTone = 'neutral' | 'brand' | 'danger' | 'warning' | 'info';

const TONES: Record<StatTone, string> = {
  neutral: 'text-text',
  brand: 'text-brand',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

export interface StatCardProps {
  /** 11px uppercase label (C10). */
  label: string;
  /** Preformatted headline value. */
  value: string;
  /** Full-precision value for the tooltip when `value` is abbreviated. */
  title?: string;
  /** Secondary line under the value. */
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  className?: string;
}

/**
 * One of the four overview KPI cards.
 * The value uses tabular figures so a changing number does not shift the layout.
 */
export function StatCard({ label, value, title, hint, icon, tone = 'neutral', className }: StatCardProps): ReactNode {
  return (
    <Card className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="label-caps">{label}</p>
        {icon ? (
          <span aria-hidden="true" className="text-muted">
            {icon}
          </span>
        ) : null}
      </div>
      <p
        title={title}
        className={cn('tabular text-2xl font-semibold leading-8 tracking-tight', TONES[tone])}
      >
        {value}
      </p>
      {hint ? <p className="text-[11px] leading-4 text-muted">{hint}</p> : null}
    </Card>
  );
}

export interface StatCardSkeletonProps {
  label: string;
}

/** Placeholder with the same height as a loaded card, so nothing jumps. */
export function StatCardSkeleton({ label }: StatCardSkeletonProps): ReactNode {
  return (
    <Card className="flex flex-col gap-2" aria-hidden="false" aria-busy="true">
      <p className="label-caps">{label}</p>
      <div className="skeleton h-8 w-24 rounded" />
      <div className="skeleton h-3 w-32 rounded" />
    </Card>
  );
}
