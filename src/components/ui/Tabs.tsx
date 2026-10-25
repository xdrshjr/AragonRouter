'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface TabItem<T extends string = string> {
  value: T;
  label: string;
  /** Optional count or state rendered after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** `segmented` = the compact range picker, `underline` = page-level tabs. */
  variant?: 'segmented' | 'underline';
  className?: string;
  size?: 'sm' | 'md';
}

/**
 * Roving-tabindex tab list (WAI-ARIA pattern).
 *
 * Only the selected tab is reachable with Tab; Arrow keys, Home and End move the
 * selection. Tabs here switch a *view inside one page* (time range, log filter),
 * which is why the panel is rendered by the caller instead of by this component.
 */
export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  label,
  variant = 'segmented',
  className,
  size = 'sm',
}: TabsProps<T>): ReactNode {
  const listRef = useRef<HTMLDivElement | null>(null);

  function focusTab(index: number): void {
    const list = listRef.current;
    if (!list) return;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'));
    if (buttons.length === 0) return;
    const wrapped = ((index % buttons.length) + buttons.length) % buttons.length;
    buttons[wrapped]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const enabled = items.filter((item) => !item.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex((item) => item.value === value);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = enabled[(currentIndex + 1) % enabled.length];
      if (next) onChange(next.value);
      focusTab(currentIndex + 1);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = enabled[(currentIndex - 1 + enabled.length) % enabled.length];
      if (previous) onChange(previous.value);
      focusTab(currentIndex - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      const first = enabled[0];
      if (first) onChange(first.value);
      focusTab(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const last = enabled[enabled.length - 1];
      if (last) onChange(last.value);
      focusTab(enabled.length - 1);
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center',
        variant === 'segmented'
          ? 'gap-0.5 rounded-md border border-border bg-surface-2 p-0.5'
          : 'gap-1 border-b border-border',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={undefined}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled) onChange(item.value);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-150 ease-console',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              'disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              variant === 'segmented'
                ? cn(
                    'rounded',
                    selected ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
                  )
                : cn(
                    '-mb-px border-b-2',
                    selected
                      ? 'border-brand text-text'
                      : 'border-transparent text-muted hover:border-border-strong hover:text-text',
                  ),
            )}
          >
            {item.label}
            {item.badge !== undefined ? <span className="tabular text-muted">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
